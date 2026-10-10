# Testing

There are three tiers. **Only the first is in the default loop**, and neither of the
others reaches anything unless it is named.

| Tier | Command | Touches | Time | When to run |
| --- | --- | --- | --- | --- |
| Hermetic | `npm test` | nothing external | ~1s | Every change |
| Browser (offline) | `npm run test:browser` | a real Chromium, a fixture YouTube | ~30s | Before a commit that changes wiring |
| Conformance | `npm run test:conformance` | the CELLAR Matroska files on disk | ~5s | After touching the container parser |

`npm run test:all` runs the first two. The conformance tier needs
`npm run conformance:fetch` once, and is a **development dependency**, a
contributor without those files can still run everything else.

## Why the split exists

The browser tests are genuinely better evidence, they run the real extension,
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

## Tier 1: hermetic (`npm test`, 1030 checks)

Boots real modules against stubbed browser globals and drives them through their
message surfaces. No network, no browser, no dependencies, plain Node scripts,
so they run with nothing installed.

| Suite | Boots | Checks |
| --- | --- | --- |
| `manifest.test.mjs` | nothing | 39 |
| `unit.test.mjs` | nothing | 104 |
| `errors.test.mjs` | the error registry | 20 |
| `learn.test.mjs` | segmenter + word list | 91 |
| `licence.test.mjs` | the licence files on disk | 49 |
| `providers.test.mjs` | the provider seam | 15 |
| `mkv-container.test.mjs` | the container parser, on generated fixtures | 72 |
| `viewer.test.mjs` | subtitle parsing, encoding, the viewer's messages | 71 |
| `marking.test.mjs` | the word-marking renderer | 21 |
| `service-worker.test.mjs` | worker + `chrome` stub | 256 |
| `sidepanel.test.mjs` | panel + DOM stub | 150 |
| `page-bridge.test.mjs` | bridge + page stub | 50 |
| `content.test.mjs` | content script | 106 |
| `history.test.mjs` | the transcript cache | 9 |

Each file is spawned as its own process, because they all grab the same globals
(`chrome`, `document`, the module cache) and a shared process lets one suite's
stubs leak into another's, which has already produced a misleading result once.
The counts above are the runner's own per-suite lines; 1030 is their sum, kept here
so a suite quietly losing cases is visible in the diff of this file.

**A stub that ignores its request cannot test behaviour that depends on it.**
The content-script stub used to return a fixed payload whatever `languageCode`
was requested, so "it kept the chosen language" passed against code that had lost
the choice. Payloads may now be functions of the request, and a race can be made
deterministic with `storageDelay`, otherwise the test passes either way.

The DOM stub models a select's value as its selected option, not as the last
value assigned. Options are rebuilt on every state push, so the older stub
reported a stale value the browser never would, and anything depending on the
selection could not be tested honestly.

PROVIDE and FETCH_TRACK return **different shapes**, `{ok, video, fetched}`
versus the segment list itself. Using one where the other belongs fails as a
silently empty transcript.

The content stub models an **orphaned extension context**: `id` absent, and
`sendMessage`/`sendResponse` throwing "Extension context invalidated." A stub
that quietly resolved would not exercise the path at all, and the bug being
pinned is precisely that the throw escaped.

## The privacy claim is a check, not a paragraph

The README says the extension collects nothing and talks to one host. That is a
statement about the code, so `manifest.test.mjs` verifies it against the code
rather than trusting the prose to stay accurate:

- **No transport but `fetch`**, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `sendBeacon`, `importScripts` and `navigator.send` all fail the suite. None is
  used, so an appearance is a new decision rather than a slip.
- **Every absolute URL host in `src/` is `youtube.com`**, and a host built at
  runtime fails too, because a URL assembled from parts cannot be vouched for.
- **The `fetch` call sites are a named list.** Two in `wordlist.js`, reading
  bundled dictionary JSON through `runtime.getURL`; one in `youtube-content.js`,
  the caption track. Adding a third changes a count and fails the test.
- **Nothing uses `storage.sync`**, settings stay on the machine, not in an
  account.

Why this exists: an extension's privacy story never breaks in one commit. It
breaks when a helpful error reporter or a remote word list is added to one file
and nothing objects, and by then the store listing, the policy and the README
have all been wrong for a release. Enforcement is the difference between a
constraint and a policy that expires.

**Teeth-checked**, because a guard that cannot fail is decoration: adding an
`XMLHttpRequest`, a `WebSocket`, a computed host and a `storage.sync` call to a
file in `src/` fails all four checks, and deleting the file returns the suite to
green.

### The permission list is checked too, and that half was missing

The scan above reads `src/`. It says nothing about what the extension is
**allowed** to do, which lives in `manifest.json`, and the privacy section makes
claims about both. There is now a second group of checks for it:

- **`host_permissions` is exactly `['https://*.youtube.com/*']`.**
- **Nothing is in `web_accessible_resources`**, which is what "no page can reach
  into the extension" actually means.
- **No `activeTab`, `tabs` or `unlimitedStorage`**, each widens what the
  extension can do on its own initiative.
- **Every script a provider names is declared in `content_scripts`**, and no
  script is injected for a site no provider claims. This is the fourth copy of
  "which sites we read" and the one that silently rots.

**The gap these close was real and measured.** Before them, expanding
`host_permissions` to `https://*.example.com/*` **and `file:///*`** left the suite
at 33/33. `file:///*` is how an extension reads files off someone's disk without
them picking a file, precisely the thing the privacy section promises does not
happen. It now fails, along with `web_accessible_resources` and an orphaned
content script.

Pinning the host list means **adding a provider is a deliberate edit to this
file**. That is the feature rather than friction: "we read one host" is a promise,
and a promise that can be widened by accident is not one.

## Tier 2: browser, offline (`npm run test:browser`, 282 checks)

Five suites, and the count is the runner's own. `iu.browser.test.mjs` (108) loads the
real extension; `viewer.test.mjs` (69) drives the local-video viewer page over
`chrome-extension://`; `ui-preview.test.mjs`, `ui-hmr.test.mjs` and
`ui-layout.test.mjs` check the design preview server, which is a development tool
rather than a test of the extension, see
[Designing the panel](#designing-the-panel) for why it is checked in at all.

**`viewer.test.mjs` drives the viewer page over `chrome-extension://`**: the real
page, the real worker, the real panel, and it exists because of a gap nothing else
covered. `mkv-container.test.mjs` proves the container parser reads real files, and
`service-worker.test.mjs` proves the worker resolves a viewer tab, but **nothing
proved those two connected, and they did not**: `settings.studyLanguage` defaults to
`null`, so the first request for any video is `PROVIDE { languageCode: null }`, and
the viewer answered "no such track". A file with three parsed subtitle tracks
produced no transcript at all, with both suites green, because neither ever asked
the viewer for a track. The YouTube path had always handled it, which is exactly why
the gap was invisible.

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
  px value rather than "it grew". This caught a real bug immediately,
  `calc(13px * calc(var(--font-size) / 13))` multiplies two lengths, which CSS
  rejects, so every one of the nine derived sizes silently fell back to the
  browser default while every hermetic test stayed green.
- **that a cascaded override does not erase a highlight**: `.row.paused` and
  `.row.active` are equal specificity, so only a real cascade shows which one
  wins. The reported "nothing is highlighted between two lines" was exactly that,
 a later rule replacing the highlight background with the page colour.

**A throttled background tab is not a failure.** The watch page is not the active
 tab while the panel is open, so its 250ms position poll is throttled. An
assertion that reads the panel immediately after opening it can therefore see a
stale state and look like a code bug, which it did, costing several rounds.
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
that opened youtube.com, a flag is not a structural constraint. It is deleted, not
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
| `npm run capture -- --check` | nothing | Preconditions, **and that the parser runs on a blank page**, the exact failure that cost a capture. |
| `npm run capture -- --replay` | nothing | The whole pipeline against the previous capture, network stubbed: routing, staging, both parsers, the normalised writes, the shape report. |
| `npm run capture -- --replay --fail-after=N` | nothing | The **failure** path: the loop throws after N requests, and the partial results must still be preserved and named. |
| `npm run capture [--force]` | **once** | The capture itself. |

The rehearsal asserts rather than prints. It checks that both formats were served,
that every body produced cues, that no markup leaked into text, that an entity
decoded and a child element flattened, and, the one most easily faked, that **no
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
video, and reading a live transcript for every change to a colour or a control,
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
chrome-free. So the real panel runs as a plain page with a fake Port, real
rendering, real stylesheet, real controls, with no extension loading.

- `tools/ui/vite.config.mjs`, root is the repository, so the page imports the
  panel by the same paths the extension uses. One plugin serves the scenarios as
  JSON, because they read the corpus from disk and the browser cannot import a
  Node module.
- `tools/ui/index.html`, the panel's markup, **duplicated** from
  `sidepanel.html` (that file ships to users and must not reference a dev tool).
  The cost is real: a control added there must be added here, and forgetting shows
  up as `Cannot read properties of null` rather than as a missing control.
- `tools/ui/boot.mjs`, installs the mock, fetches the scenario, then imports the
  panel. The import must be last and dynamic, because the panel calls `connect` at
  module scope.
- `tools/ui/mock-worker.mjs`, imports the **real** protocol constants, settings
  schema and alignment function, so it cannot drift from what the panel expects.
- `tools/ui/scenarios.mjs`, **Node-only**; the server serialises a scenario and
  sends it as data.
- `?scenario=` switches; `?view=`, `?fontSize=`, `?threshold=` override settings so
  a state can be linked to rather than rebuilt by clicking.

**HMR is the point, and it is tested.** `test/browser/ui-hmr.test.mjs` edits the
real stylesheet, waits for the change to arrive, and asserts the page did **not**
reload, a dev server that reloads on every CSS save would lose the entire
benefit, and would pass a smoke test. An earlier hand-rolled server had no HMR at
all, which is why it was replaced.

**What it does not do.** It does not run the extension, the content scripts, the
real caption fetch, or the real marking. A layout proved here is a layout; a fetch
proved here is nothing. That is `test/browser/iu.browser.test.mjs`'s job.

**Why it is tested at all.** Tools like this rot: a control renamed in
`sidepanel.html` and not here shows up as a blank page, and nobody notices until
they next want to use it. `test/browser/ui-preview.test.mjs` therefore asserts that
every scenario renders, that each one's distinctive feature is on screen, and that
no console error was raised. It asserts nothing about appearance, that is what the
preview is for.

## Where the fixtures come from

Two kinds, and mixing them up is the mistake this repository made for a long time.

**`test/synthetic/` is committed** and is what tests read. It is our own invented
text wearing shapes measured from a real capture, real cue counts, real timings
including the offsets and the silences, real language codes, real renderer keys.
Shape from reality, text from us, which is what makes it both faithful and
committable.

**`test/fixtures/` is local and gitignored** and is where that shape comes from.
`npm run capture` opens the real site once per video, the only thing in the project
that ever does, and `npm run derive-synthetic` turns the result into the corpus.

Why it is arranged this way: every fixture used to be hand-written from an idea of
what YouTube sends, so the tests could only confirm the idea. Thirteen bugs were
reported from use and not one was found by the suite. A fixture is only worth
something if its shape traces to something real.

The loader falls back to a tiny self-contained fixture when nothing has been
derived, so a fresh clone can still run `npm test`. Do not assert on the fallback:
it is a bootstrapping aid, not a second source of truth.

### The MKV fixtures are generated, not committed

`test/mkv/*.mkv` is produced by `npm run fixtures`, which drives `ffmpeg` over a
synthesised test pattern. No third-party media, nothing to attribute, and two
seconds to rebuild, which is why they are generated rather than checked in as
opaque binaries.

They live in their own directory rather than in `test/fixtures/` because the two
are gitignored for **different reasons** and only one is reproducible:

| Directory | Holds | Ignored because |
| --- | --- | --- |
| `test/fixtures/` | real caption captures | a capture carries a signed URL and a real title |
| `test/mkv/` | generated MKV containers | regenerating is cheaper than storing |
| `test/conformance/` | the fetched CELLAR suite | 190 MB of CC-BY film |

All three are local-only. Collapsing them into one directory would hide that only
the first is irreplaceable.

There are five, and each exists for a case a simpler file cannot reach: three text
subtitle tracks with real language metadata, a genuine `S_TEXT/ASS` track (whose
events are stored differently from SRT's), one with no subtitle tracks at all, one
with `language=und`, and one with **no `Language` element whatever**, which is not
the same thing, and the difference turned out to matter.

## Measurements that settled a design question

Some facts were settled by a throwaway script that opened a real browser, measured,
and printed for a person to read. The scripts have been removed, because an
unasserted script in the test directory is clutter that never runs. What they
measured decided real code, so the answers are kept here rather than lost with them.

None of this is a test. Where a fact could be pinned, it was, and that is said per
line:

- **Which audio track does Chrome play from a multi-track file?** The first, every
  time. Established by routing playback through an `AnalyserNode` and reading the
dominant frequency, because the fixture's two tracks are 440 Hz and 880 Hz and
  nothing else in the pipeline can fake that. **A real test now**: `viewer.test.mjs`
  carries the same measurement, so the fact is pinned rather than trusted.
- **Can the element play AC-3, when WebCodecs cannot decode it?** Yes. A `<video>`
  element is not WebCodecs: it has the browser's own demuxer and its own platform
  decoders. Remuxing copies bytes and never decodes, so a codec only needs to be
  playable, never decodable by us.
- **Which codecs can WebCodecs decode?** AAC and MP3 yes; AC-3, E-AC-3 and DTS no.
  This is why the audio path remuxes instead of decoding, and it is the reason that
  choice is not a preference: a decoder of our own would work on some real files and
  silently not on others.
- **What does `canPlayType` accept?** A measurement, deliberately not a gate. MKV
  reports nothing even for files Chrome plays, so it cannot decide anything; the only
  honest signal is the element's `error` event after a play attempt.
- **Can `audioTracks` be switched on without a startup flag?** No. It is compiled in
  and flagged off, and no page-level switch reaches it. Feature detection is the
  whole answer, and the feature lands for free the day Chrome unflags it.

## Tier 3, conformance (`npm run test:conformance`, 22 checks)

**Optional, and a development dependency.** The files are the [IETF CELLAR working
group's Matroska conformance
suite](https://github.com/ietf-wg-cellar/matroska-test-files), eight files, each
probing one feature, written by the people who maintain mkvmerge and libmatroska.
They are downloaded, never committed:

```sh
npm run conformance:fetch     # once, ~190 MB
npm run test:conformance
```

This is **not** the live tier that was deliberately deleted. That one reached a
website and was a second thing that could break; these are static files fetched
once, and nothing runs them unless they are named. `test/conformance/` sits in a
subdirectory `test/run.mjs` does not scan, so a contributor without the files can
still run `npm test`.

**Why they are worth 190 MB, given we already have fixtures.** Every generated
fixture comes from one muxer with default settings, and that was a real blind spot
rather than a theoretical one. The suite found two parser bugs on its first run,
neither of which any fixture in this repository could have caught:

- **`TimecodeScale` was never read.** Block timestamps are integer ticks and the
  scale says how long one is. The parser divided by 1000, which is correct only for
  the default of one millisecond, so `test2.mkv`, which sets 100,000, had **every
  timestamp ten times too large**: a two-minute film's subtitles landing at twenty
  minutes, with no error and a complete-looking transcript. `ffmpeg` cannot write a
  non-default scale, so no fixture here could have reached it.
- **An absent `Language` element was treated as unknown.** Matroska defines the
  element as defaulting to English, and the suite's many-language file relies on
  that, its English track carries no language tag at all. We were reporting it as
  undetermined, so the English subtitles were offered in the panel and **never
  marked**, because no word list matches `null`.

Both were the same shape: correct-looking output that was quietly wrong. That is
what a conformance suite is for, and it is a different job from our fixtures, which
test *our* features (ASS-in-container, image-codec refusal, language metadata) that
a container-conformance suite has no reason to include.

A file we knowingly cannot fully read is asserted as a named limitation rather than
skipped, so the day the parser improves the assertion has to change and somebody
notices.


## The real XML body, and what it settled

There was a gap here for a long time, and it is worth recording what closed it,
because the shape of the answer was not what had been assumed.

**The gap.** Every capture requested `fmt=json3`, so the default-format row never
produced a body. The XML branch was only ever exercised against XML *we* built from
JSON3, a test of the parser, not of what YouTube sends.

**What the second capture found.** A request with no `fmt`, from the ANDROID client,
returns `text/xml`, the older `<transcript><text start=… dur=…>` shape, not JSON3.
So the default-format path was genuinely a different serialisation, and the parser
had been right about its structure all along, from a fixture that was at least
structurally honest. Two facts the real body settled that no fixture had:

- The English track carries **161 `&amp;` entities**, escaping is routine, not
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

## Running against CI, in a container

```bash
tools/ci/run-in-ci.sh npm test
tools/ci/run-in-ci.sh npm run test:browser
tools/ci/run-in-ci.sh --shell          # poke at it
tools/ci/run-in-ci.sh --rebuild ...    # after changing the Dockerfile
```

**This is the first thing to reach for when CI and the local machine disagree.**
That situation cost three wrong fixes in one day: a test failed roughly one run in
six locally and nearly every run in CI, and every diagnosis made from the local
machine was wrong. The three attempts were all plausible and all unverifiable,
because the environment that failed was not available to test against.

The image is Ubuntu 24.04, which is what `ubuntu-latest` maps to, with the Node
version read from `.nvmrc` (the same file the workflow reads, so the two cannot
disagree), plus `ffmpeg`, `make` and Playwright's Chromium with its system
dependencies. The repository is mounted, not copied, so it always tests the
working tree.

Two details that are the difference between a faithful container and a
misleading one, both of which produced a green result that meant nothing:

- **`PLAYWRIGHT_BROWSERS_PATH` must not be set.** `findChrome` looks only in
  `$HOME/.cache/ms-playwright`, because that is where `playwright install` puts
  the browser on every machine and every runner. Pointing it elsewhere made the
  whole tier `SKIP` and report green.
- **The mount needs `git config --global --add safe.directory /repo`.** The
  mounted `.git` belongs to the host user, so git refuses it as *dubious
  ownership*, and `history.test.mjs` silently skipped its nine checks and
  reported `0/0`, which looks identical to passing. CI checks out as the runner
  user and never hits this.

Neither is in `npm test`, deliberately: this is a debugging tool, run by hand.

### A suite that skips is not a suite that passes

Both problems above share a shape worth naming, because the browser tier already
guards against it and `history.test.mjs` does not. A skip that reports green is
worse than a failure, because the failure is visible. The workflow asserts the
browser tier did **not** skip for exactly this reason; `history.test.mjs` prints
`(no git repository, history checks skipped)` and returns `0/0`, which the runner
reports as `ok`. A future pass should make that a failure or an explicit
`SKIP` line, so the count cannot be mistaken for coverage.
