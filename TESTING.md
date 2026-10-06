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

## Tier 1 — hermetic (`npm test`, 533 checks)

Boots real modules against stubbed browser globals and drives them through their
message surfaces. No network, no browser, no dependencies — plain Node scripts,
so they run with nothing installed.

| Suite | Boots | Checks |
| --- | --- | --- |
| `unit.test.mjs` | nothing | 48 |
| `service-worker.test.mjs` | worker + `chrome` stub | 190 |
| `sidepanel.test.mjs` | panel + DOM stub | 99 |
| `page-bridge.test.mjs` | bridge + page stub | 50 |
| `content.test.mjs` | content script | 93 |
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

## Tier 2 — browser, offline (`npm run test:browser`, 107 checks)

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

## What we do not have yet

Stated plainly, because the alternative is a suite that looks broader than it is.

**No real XML caption body.** Every capture so far requested `fmt=json3`, so the
`default format` row in the collection plan has never produced a body we hold. The
XML branch of the parser is therefore only ever exercised against XML *we* built
from JSON3 — including in `--replay`, whose stubbed route synthesises the XML. That
tests the parser, but it does not prove what YouTube actually sends by default. The
collection plan now asks for the default format first for exactly this reason.

Consequences to keep in mind:

- A green rehearsal does **not** mean the default-format path is verified. It means
  the code that will handle it is.
- `derive-synthetic.mjs` must skip, with a visible message, when a source capture has
  no XML body — never fall back to the JSON3-derived stand-in and let the result read
  as if a real body had been seen.

## Where the browser comes from

The bundled Playwright headless shell **cannot load extensions**. A full browser
is required, and `harness.mjs` looks in this order:

1. `$CHROME_PATH`
2. `~/.cache/ms-playwright/chromium-<build>/chrome-linux64/chrome`
3. `/usr/bin/google-chrome`, `/usr/bin/chromium`

If none is found the browser tiers report `SKIP` and exit zero, so a machine
without one can still run everything else. `--headless` with a full Chromium is
used rather than the headless shell, which is why this works in a container.
