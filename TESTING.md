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

## Tier 1 — hermetic (`npm test`, 460 checks)

Boots real modules against stubbed browser globals and drives them through their
message surfaces. No network, no browser, no dependencies — plain Node scripts,
so they run with nothing installed.

| Suite | Boots | Checks |
| --- | --- | --- |
| `unit.test.mjs` | nothing | 48 |
| `service-worker.test.mjs` | worker + `chrome` stub | 178 |
| `sidepanel.test.mjs` | panel + DOM stub | 81 |
| `page-bridge.test.mjs` | bridge + page stub | 42 |
| `content.test.mjs` | content script | 67 |
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

## Tier 2 — browser, offline (`npm run test:browser`, 80 checks)

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

## Tier 3 — browser, live (`npm run test:browser:live`)

Hits the real youtube.com. Requires the flag; there is no command that reaches it
by accident.

This is the only test that can notice YouTube changing the page out from under
us — the player response moving, the caption track list being reshaped, or the
same-origin caption fetch being refused so the INNERTUBE fallback takes over.
Everything else tests our understanding of the page against fixtures we wrote,
which cannot disagree with itself.

Expect it to be unreliable, and read its output rather than its exit code. A
headless browser on a datacenter IP is often served a consent wall instead of a
video, and the suite prints what it actually saw so a failure is diagnosable. A
failure here is a prompt to look, not a broken build.

Override the video with `IU_LIVE_VIDEO=<id>`.

## Where the browser comes from

The bundled Playwright headless shell **cannot load extensions**. A full browser
is required, and `harness.mjs` looks in this order:

1. `$CHROME_PATH`
2. `~/.cache/ms-playwright/chromium-<build>/chrome-linux64/chrome`
3. `/usr/bin/google-chrome`, `/usr/bin/chromium`

If none is found the browser tiers report `SKIP` and exit zero, so a machine
without one can still run everything else. `--headless` with a full Chromium is
used rather than the headless shell, which is why this works in a container.
