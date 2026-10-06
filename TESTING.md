# Testing

There are three tiers, ordered by how expensive they are and how often they
should run. **Only the first is in the default loop.** The others are opt-in, and
the one that reaches the network needs an explicit flag.

| Tier | Command | Touches | Time | When to run |
| --- | --- | --- | --- | --- |
| Hermetic | `npm test` | nothing external | ~1s | Every change |
| Browser (offline) | `npm run test:browser` | a real Chromium, fixture YouTube | ~10s | Before a commit that changes wiring |
| Browser (live) | `npm run test:browser:live` | real youtube.com | ~30s | Rarely, by hand |

`npm run test:all` runs the first two. Nothing runs the live tier unless it is
named.

## Why the split exists

The browser tests are genuinely better evidence — they run the real extension,
with the real service worker, real content scripts injected through
`chrome.scripting`, and a real panel document. They found three bugs the hermetic
suite could not: an in-tab video switch that left the old transcript on screen,
a worker that could not tell which tab had reported, and a click that did not
highlight.

They are also slow (launching Chromium costs more than every case in the file put
together) and they need a browser installed. Put in the default loop they would
make `npm test` something to avoid, which is the worst outcome available.

So: the fast tier stays fast and runs constantly, and the slow tier is pulled out
deliberately.

## Tier 1 — hermetic (`npm test`, 568 checks)

Boots real modules against stubbed browser globals and drives them through their
message surfaces. No network, no browser, no dependencies — plain Node scripts,
so they run with nothing installed.

| Suite | Boots | Checks |
| --- | --- | --- |
| `unit.test.mjs` | nothing | 48 |
| `manifest.test.mjs` | nothing | 23 |
| `service-worker.test.mjs` | worker + `chrome` stub | 199 |
| `sidepanel.test.mjs` | panel + DOM stub | 106 |
| `page-bridge.test.mjs` | bridge + page stub | 50 |
| `content.test.mjs` | content script | 98 |
| `learn.test.mjs` | segmenter + word list | 44 |

Each file is spawned as its own process, because they all grab the same globals
(`chrome`, `document`, the module cache) and a shared process lets one suite's
stubs leak into another's — which has already produced a misleading result once.

**A stub that ignores its request cannot test behaviour that depends on it.**
The content-script stub used to return a fixed payload whatever `languageCode`
was requested, so "it kept the chosen language" passed against code that had lost
the choice. Payloads may now be functions of the request, and a race can be made
deterministic with `storageDelay` — otherwise the test passes either way.

The DOM stub models a select's value as its selected option, not as the last
value assigned. Options are rebuilt on every state push, so the older stub
reported a stale value the browser never would, and anything depending on the
selection could not be tested honestly.

PROVIDE and FETCH_TRACK return **different shapes** — `{ok, video, fetched}`
versus the segment list itself. Using one where the other belongs fails as a
silently empty transcript.

The content stub models an **orphaned extension context**: `id` absent, and
`sendMessage`/`sendResponse` throwing "Extension context invalidated." A stub
that quietly resolved would not exercise the path at all, and the bug being
pinned is precisely that the throw escaped.

## Tier 2 — browser, offline (`npm run test:browser`, 179 checks)

Three suites. `iu.browser.test.mjs` (108) loads the real extension; `ui-preview.test.mjs`
(67) and `ui-hmr.test.mjs` (4) check the design preview server, which is a
development tool rather than a test of the extension — see
[Designing the panel](#designing-the-panel) for why it is checked in at all.

The real extension in real Chromium. The only thing faked is the network, and it
is intercepted at the transport layer with `context.route`, so the content script
genuinely fetches and genuinely parses.

Covers what the hermetic tier structurally cannot:

- content scripts actually injecting into an already-open tab, through
  `chrome.scripting` and `webNavigation`
- a real `fetch` of a caption track, and a real seek on a real `<video>`
- the panel's port surviving, and the worker's cache serving a warm video
- two languages rendering together after alignment
- **that the stylesheet does what it says**: the focus view really hides rows
  (measured as zero-height boxes) and a text-size change really moves the
  computed font size. A hermetic test only sees the class, so a selector typo
  would pass it while the panel hid nothing.
- **that auto-translate really reaches YouTube**: the `tlang` URL is built by the
  content script, fetched over a real route, and re-rendered by the real panel,
  then changed back. A hermetic test stubs the fetch, so it can never show the
  parameter arriving.
- **that derived CSS actually computes**: the font size is asserted as an exact
  px value rather than "it grew". This caught a real bug immediately —
  `calc(13px * calc(var(--font-size) / 13))` multiplies two lengths, which CSS
  rejects, so every one of the nine derived sizes silently fell back to the
  browser default while every hermetic test stayed green.
- **that a cascaded override does not erase a highlight**: `.row.paused` and
  `.row.active` are equal specificity, so only a real cascade shows which one
  wins. The reported "nothing is highlighted between two lines" was exactly that
  — a later rule replacing the highlight background with the page colour.

**A throttled background tab is not a failure.** The watch page is not the active
 tab while the panel is open, so its 250ms position poll is throttled. An
assertion that reads the panel immediately after opening it can therefore see a
stale state and look like a code bug — which it did, costing several rounds.
Wait for the CONDITION, never for "long enough".

Notable details in `test/browser/harness.mjs`, all of which cost time to find:

- **The extension id is computed** from its absolute path, not discovered by
  waiting for the worker. An MV3 worker is lazy, so waiting for it before
  navigating deadlocks.
- **The panel is opened as a tab, then the watch page is brought back to the
  front.** A real side panel is never the active tab; opening the panel as one
  makes it active, and the worker resolves the video from the active tab.
- **Routes are registered once and dispatch on `?v=`.** Playwright matches routes
  last-registered-first, so two `watch**` handlers silently serve whichever was
  registered most recently for every video.
- **`currentTime` is read, not overridden.** Chrome gives each world its own
  wrapper for a DOM node, so an accessor installed by the page is not what an
  isolated-world content script's assignment reaches.

## There is no live tier

There used to be. It was gated behind `--live`, and it was still a second thing
that opened youtube.com — a flag is not a structural constraint. It is deleted, not
disabled.

Noticing YouTube changing shape is now the capture tool's job: re-run
`npm run capture`, and the derived corpus stops matching. One deliberate open per
video, taken when you decide to take it, rather than a suite that reaches the
network whenever someone remembers the flag exists.

## The capture tool has four modes, and only one of them opens anything

`tools/capture.mjs` is the only file in the project that touches youtube.com, so the
modes that do not are where the work happens. All three offline modes were added
because a capture is single-shot: a failure discovered during the open is a failure
discovered in the one place it cannot be repeated.

| Command | Opens | What it proves |
| --- | --- | --- |
| `npm run capture -- --list` | nothing | The plan: which videos, which already captured. |
| `npm run capture -- --check` | nothing | Preconditions, **and that the parser runs on a blank page** — the exact failure that cost a capture. |
| `npm run capture -- --replay` | nothing | The whole pipeline against the previous capture, network stubbed: routing, staging, both parsers, the normalised writes, the shape report. |
| `npm run capture -- --replay --fail-after=N` | nothing | The **failure** path: the loop throws after N requests, and the partial results must still be preserved and named. |
| `npm run capture [--force]` | **once** | The capture itself. |

The rehearsal asserts rather than prints. It checks that both formats were served,
that every body produced cues, that no markup leaked into text, that an entity
decoded and a child element flattened, and — the one most easily faked — that **no
request received a format other than the one it asked for**. A body is classified by
what it *is*, not by what was requested, so a server disagreeing is recorded as the
disagreement it is instead of as the format we hoped for.

`--fail-after` exists because the failure path is the one that matters and had never
run. A mid-loop throw must leave a `<id>.partial/` beside the untouched good capture,
with both manifests written, so a spent open still yields evidence to derive from.

## Designing the panel

`npm run ui` serves the side panel at `http://127.0.0.1:8099` with **Vite**, for
iterating on layout without loading the extension.

It exists because the alternative was loading the extension, opening a YouTube
video, and reading a live transcript for every change to a colour or a control —
and because the states worth designing against (one subtitle, nothing marked, a
long silence, an error) are the hardest to reach on demand. Reading a real
transcript while working on layout is also a licence problem, which is why
`test/fixtures/` is local and gitignored.

**Why Vite and not Storybook.** This is one 57-line panel, not a component
library; Storybook's isolated-component model has nothing to model here. What was
wanted was a dev server with hot module replacement. Storybook would have replaced
roughly the same amount of code while adding a much larger dependency and a build
the project does not otherwise have.

**Why it works at all.** The panel's **entire** contact with the extension is
`chrome.runtime.connect` returning a Port, and every module it imports is
chrome-free. So the real panel runs as a plain page with a fake Port — real
rendering, real stylesheet, real controls — with no extension loading.

- `tools/ui/vite.config.mjs` — root is the repository, so the page imports the
  panel by the same paths the extension uses. One plugin serves the scenarios as
  JSON, because they read the corpus from disk and the browser cannot import a
  Node module.
- `tools/ui/index.html` — the panel's markup, **duplicated** from
  `sidepanel.html` (that file ships to users and must not reference a dev tool).
  The cost is real: a control added there must be added here, and forgetting shows
  up as `Cannot read properties of null` rather than as a missing control.
- `tools/ui/boot.mjs` — installs the mock, fetches the scenario, then imports the
  panel. The import must be last and dynamic, because the panel calls `connect` at
  module scope.
- `tools/ui/mock-worker.mjs` — imports the **real** protocol constants, settings
  schema and alignment function, so it cannot drift from what the panel expects.
- `tools/ui/scenarios.mjs` — **Node-only**; the server serialises a scenario and
  sends it as data.
- `?scenario=` switches; `?view=`, `?fontSize=`, `?threshold=` override settings so
  a state can be linked to rather than rebuilt by clicking.

**HMR is the point, and it is tested.** `test/browser/ui-hmr.test.mjs` edits the
real stylesheet, waits for the change to arrive, and asserts the page did **not**
reload — a dev server that reloads on every CSS save would lose the entire
benefit, and would pass a smoke test. An earlier hand-rolled server had no HMR at
all, which is why it was replaced.

**What it does not do.** It does not run the extension, the content scripts, the
real caption fetch, or the real marking. A layout proved here is a layout; a fetch
proved here is nothing. That is `test/browser/iu.browser.test.mjs`'s job.

**Why it is tested at all.** Tools like this rot: a control renamed in
`sidepanel.html` and not here shows up as a blank page, and nobody notices until
they next want to use it. `test/browser/ui-preview.test.mjs` therefore asserts that
every scenario renders, that each one's distinctive feature is on screen, and that
no console error was raised. It asserts nothing about appearance — that is what the
preview is for.

## Where the fixtures come from

Two kinds, and mixing them up is the mistake this repository made for a long time.

**`test/synthetic/` is committed** and is what tests read. It is our own invented
text wearing shapes measured from a real capture — real cue counts, real timings
including the offsets and the silences, real language codes, real renderer keys.
Shape from reality, text from us, which is what makes it both faithful and
committable.

**`test/fixtures/` is local and gitignored** and is where that shape comes from.
`npm run capture` opens the real site once per video — the only thing in the project
that ever does — and `npm run derive-synthetic` turns the result into the corpus.

Why it is arranged this way: every fixture used to be hand-written from an idea of
what YouTube sends, so the tests could only confirm the idea. Thirteen bugs were
reported from use and not one was found by the suite. A fixture is only worth
something if its shape traces to something real.

The loader falls back to a tiny self-contained fixture when nothing has been
derived, so a fresh clone can still run `npm test`. Do not assert on the fallback:
it is a bootstrapping aid, not a second source of truth.

## The real XML body, and what it settled

There was a gap here for a long time, and it is worth recording what closed it,
because the shape of the answer was not what had been assumed.

**The gap.** Every capture requested `fmt=json3`, so the default-format row never
produced a body. The XML branch was only ever exercised against XML *we* built from
JSON3 — a test of the parser, not of what YouTube sends.

**What the second capture found.** A request with no `fmt`, from the ANDROID client,
returns `text/xml` — the older `<transcript><text start=… dur=…>` shape, not JSON3.
So the default-format path was genuinely a different serialisation, and the parser
had been right about its structure all along, from a fixture that was at least
structurally honest. Two facts the real body settled that no fixture had:

- The English track carries **161 `&amp;` entities** — escaping is routine, not
  theoretical. The hermetic test stub used to leave entities raw, which made every
  escaping bug a passing test; it now decodes them, with a cue containing a real
  `&` and `<` to prove the round-trip.
- The two tracks differ: `zh-Hans` has **0** entities, `en` has **161**. A single-
track fixture would have hidden that escaping is per-track content, not a format
  property.

The measured shape is in `test/synthetic/*/shape-report.json` under `measured.xml`,
read from the captured bytes rather than declared. When a capture has no XML body,
`derive-synthetic.mjs` says so plainly instead of substituting the JSON3-derived
stand-in, and the rehearsal falls back to synthesis with that fact visible.

## Where the browser comes from

The bundled Playwright headless shell **cannot load extensions**. A full browser
is required, and `harness.mjs` looks in this order:

1. `$CHROME_PATH`
2. `~/.cache/ms-playwright/chromium-<build>/chrome-linux64/chrome`
3. `/usr/bin/google-chrome`, `/usr/bin/chromium`

If none is found the browser tiers report `SKIP` and exit zero, so a machine
without one can still run everything else. `--headless` with a full Chromium is
used rather than the headless shell, which is why this works in a container.
