# IU Language Companion

A Chinese, Japanese and Korean dictionary for video. It reads the subtitles of the
video you are watching and shows them as a transcript you can look words up in.

YouTube, or a video file on your own computer. Chrome, Edge, Brave and Firefox.
Free, open source, no account.

> **IU**, *I* and *you*. 友 means **friend** in Hokkien (*iú*), Mandarin (*yǒu*)
> and Japanese (*tomo*).

## Status

**Not published yet.** The extension works and is being prepared for the **Chrome
Web Store** and **Firefox Add-ons (AMO)**. One build serves both: the manifest
declares each browser's keys and each ignores the other's.

Until it is listed, install it from the source below.
[`CHROMEWEBSTORE.md`](CHROMEWEBSTORE.md) holds the store listing copy, permission
justifications and privacy disclosure.

## Install from source

Load the folder in either browser, from a clean copy of the source, not a working
tree with `node_modules/` and `docs/` in it.

**Chrome / Edge / Brave** (116+):

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the folder.
3. Open a video, then click the toolbar icon to open the side panel.

**Firefox** (128+):

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**.
2. Select `manifest.json` in that folder.
3. Open a video, then click the toolbar icon, the panel opens as a sidebar.

Firefox removes temporary add-ons when it closes; a permanent install needs the
signed build from AMO.

YouTube tabs that are **already open** work in both, the content scripts are
injected on demand, so there is nothing to reload.

## What it does

- **Marks the words you don't know.** Choose HSK for Chinese, JLPT for Japanese,
  or NIKL or Yonsei for Korean, and the level you are working at. Words at or above
  it are underlined in a colour for their level; words you know are left plain.
- **Defines any word on hover.** Reading and meaning. Chinese shows pinyin,
  Japanese shows kana or rōmaji, Korean shows rōmaja or the Hangul respelling. A
  word shows every list that places it, HSK 2.0 and HSK 3.0 frequently disagree,
  and both are shown.
- **Shows two subtitle tracks at once.** The language you are learning with a
  second line beneath it. Either line can be a machine translation where the video
  offers one; translated lines are tagged so they are not mistaken for a real
  track.
- **Follows playback.** The current line is highlighted and the list scrolls with
  it. Clicking a line seeks the video to that moment.
- **Exports** the transcript as plain text or an SRT subtitle file.

## How it works

The **service worker owns the transcript table**; the panel is a subscriber that
renders what it is sent; content scripts are stateless fetch providers. That split
is what makes tab switching instant, and it is why transcripts survive a panel
being closed.

Caption tracks are not in the DOM, they live in the page's own JS as
`ytInitialPlayerResponse`. An isolated-world content script cannot read that, so a
tiny MAIN-world bridge hands it over:

```mermaid
sequenceDiagram
    participant SP as Side panel
    participant SW as Service worker
    participant CS as Content script (isolated)
    participant PB as Page bridge (MAIN world)
    participant YT as youtube.com

    SP->>SW: (port connect)
    SW->>CS: PROVIDE
    CS->>PB: postMessage get-player-response
    PB-->>CS: captionTracks
    CS->>YT: fetch track baseUrl (same-origin, session cookies)
    YT-->>CS: timedtext JSON3 / XML
    CS-->>SP: segments [{ start, duration, text }]
```

Captions are fetched by the content script with the page's own session. The
internal player API is the fallback when a direct fetch is refused.

All site-specific knowledge, the player response shape, the two timedtext
formats, track selection, seeking, is confined to
`src/content/youtube-content.js`. Everything above it deals in
`{ start, duration, text }`, so a second provider is a content script plus a
registry entry.

```
manifest.json
src/
  common/        messages, transcript formatting/alignment, settings, errors
  content/       page-bridge.js (MAIN world) + youtube-content.js (fetch/parse/seek)
  background/    service worker: transcript table, tab tracking, marking
  learn/         word lists, dictionaries, segmenter  (imports nothing)
  sidepanel/     renders state, sends intents
  viewer/        local video source: player page, MKV parser, subtitles, audio
  offscreen/     PARKED: owns the MediaStream + engine
  engines/       PARKED: recogniser adapter + registry
  vendor/        mediabunny.js, generated, MPL-2.0 (see THIRD-PARTY.md)
```

`src/learn/` deliberately imports nothing and touches no `chrome` API, so it can
be reused outside an extension. Both content scripts are injected as **classic**
scripts and cannot `import`, so they repeat the message names and the
`findActiveIndex` helper that also live in `src/common/`. Both places say so.

## Word lists and languages

Chinese, Japanese and Korean work.

Levels are data, not code: each list declares its own levels, names and language,
so adding a list is a data change, and adding a language is a dictionary plus a
row in the generated index.

| Language | Lists |
| --- | --- |
| Chinese | HSK 2.0 (6 levels), HSK 3.0 (9 levels) |
| Japanese | JLPT (N5 to N1) |
| Korean | NIKL (A to C), Yonsei (course volumes 1 to 6) |

All three dictionaries are bundled and parsed on demand. Nothing is fetched from a
server we run.

**Korean is newer and thinner than the other two, and it is worth knowing why.**
Its words come from two unrelated sources: a graded word list from the National
Institute of Korean Language, and a six-volume course companion that supplies the
definitions. They cover substantially different words, which is why both are
offered, but only the course source glosses what it holds, so **about half of
Korean words have no definition yet**. Those words still mark, and the hover says
so. See the known limitations below.

**Readings are available in more than one script, because a learner's script ability
is not the same as their vocabulary level.** Each language has its own reading
setting, so a beginner who cannot yet read the script is not stuck and a fluent
reader can turn the annotation off:

| Language | Readings offered |
| --- | --- |
| Chinese | Pinyin, Pinyin with tone numbers, off |
| Japanese | Kana, Rōmaji, off |
| Korean | Rōmaja, the spelling form, the Hangul respelling, off |

A reading is shown for **anything on screen**, not only for words the dictionary
holds. Korean `는` and Japanese `とても` have no useful dictionary reading, so they are
read from the script itself: Hangul composes into rōmaja, and kana maps to rōmaji.
Chinese is the exception and stays lexical, because a hanzi's reading cannot be
derived from the character.

## Development

```bash
npm test               # hermetic suites, no browser, no network
npm run test:browser   # real Chromium, fixture pages
npm run ui             # Vite preview of the side panel, for layout work
```

The dictionaries are generated and committed. `npm run wordlists:check` fetches the
pinned sources, rebuilds, and fails on any difference, which is what catches a data
file that was edited by hand, and it runs in CI.

There are no runtime dependencies, and for anyone using or testing the extension
there is no build step: the repository is the extension. One generated file,
`src/vendor/mediabunny.js`, is committed, so nothing has to be installed to load or
package it; rebuild it with `node tools/build-vendor.mjs` if its version changes. It
bundles the container library and the two coder packages that supply Dolby audio
decoding and AAC encoding, which a browser's own WebCodecs may not have. There is no
other build product, and the release path needs no compiler. See `THIRD-PARTY.md`
for the obligations and `THIRD-PARTY-NOTES.md` for the pins and the hashes.

### The commit hook

```bash
git config core.hooksPath .githooks   # once per clone
```

`.githooks/pre-commit` runs `tools/check-staged.mjs`, which reads the staged diff
for the things a commit should not contain: an em dash, a merge conflict marker, a
leftover `debugger`, a focused test (`.only`, which silently disables the rest of
its suite), trailing whitespace, and any file over 8 MB. It runs in milliseconds
because it reads only what is staged.

The hook is a convenience, not a gate. `core.hooksPath` is a per-clone setting, so a
fresh clone has no hook until it runs that command, and CI does not depend on it.
Bypass it with `git commit --no-verify` when it is wrong.

### The demo page

```bash
npm run ui             # dev server; the demo is at http://127.0.0.1:8099/pages-demo/
npm run pages:build    # -> build/pages, for a static server or the deploy
npm run pages:media    # rebuild the committed demo clip from archive.org
```

`tools/pages/` builds a demo of the **shipped** viewer on a plain web page, with a
small shim standing in for the `chrome.*` APIs, and `.github/workflows/pages.yml`
publishes it to GitHub Pages on every push to `main`. It is the same viewer people
install, not a copy, so the page cannot drift from the extension.

**Use `npm run ui` to look at it.** The sample-video offer on the page is gated to a
`*.github.io` host, because the media only exists on the deployed site, so with a
plain static server you would never see it. The dev server builds with
`--force-offer`, which blanks that check for the preview, and serves the result under
`/pages-demo/`, so the page has the same relative-path layout the deploy has.

The media is committed and public domain. [`THIRD-PARTY-NOTES.md`](THIRD-PARTY-NOTES.md)
records its source, licence and the exact recipe that reproduces it.

> If you change anything under `tools/pages/`, check it served from a **subpath**, not
> the domain root. Pages serves a project site from `/<repo>/`, and root-absolute
> paths (an `import '/src/...'`, or `runtime.getURL` returning `/${path}`) 404 there
> while working perfectly at the root. `npm run ui` serves the demo from a subpath
> too, so the same mistake shows up there.

### Building the store package

```bash
make release           # stage, lint, zip, verify -> build/iu-language-companion-<version>.zip
```

One ZIP serves both stores: the manifest carries each browser's keys and each
ignores the other's, so there is nothing to build differently for Chrome and
Firefox. `make help` lists the individual steps (`stage`, `lint`, `zip`, `verify`).

The list of what ships lives in the Makefile, and `make verify` asserts the
archive contains exactly that.

[`TESTING.md`](TESTING.md) covers the tiers, what each suite does and does not
cover, the panel preview in detail, and where the fixtures come from.
[`CHROMEWEBSTORE.md`](CHROMEWEBSTORE.md) holds the listing copy, permission
justifications and privacy disclosure for both stores.

### Cross-browser

One manifest serves Chrome and Firefox. `background` declares both `service_worker`
(Chrome) and `scripts` (Firefox); `side_panel` and `sidebar_action` are declared
side by side, and each browser ignores the key it does not know. Code reads
`globalThis.browser ?? globalThis.chrome` at each use site, so no bundler or
polyfill is involved.

The one genuinely browser-specific call is opening the panel: Chrome's
`sidePanel.open` and Firefox's `sidebarAction.toggle` are incompatible, and that
handler feature-detects. Everything else is identical.

Adding a third target means checking `world: "MAIN"` support and the sidebar API
for that browser; the rest is the same source.

## AI use

This project is developed with AI coding assistance, and we support that use
where it respects privacy and serves the common good. That is part of why this
extension collects nothing, has no server and no account, and why the source is
open under MIT.

The bar does not move for AI-assisted work: every claim in these documents is
checked by a test against the shipped source, and a human reviews before merge.
See [`AI-USE.md`](AI-USE.md).

Agents working in this repository should read [`AGENTS.md`](AGENTS.md).

## Permissions

| Permission         | Why                                                     |
| ------------------ | ------------------------------------------------------- |
| `sidePanel`        | Render the transcript UI.                                |
| `storage`          | Remember your language and level choices.                |
| `scripting`        | Inject the content scripts on demand.                    |
| `webNavigation`    | Track which video the tab is on.                         |
| `contextMenus`     | Put **Open video files…** on the extension's own toolbar menu. Adds nothing to the page right-click menu, and grants no access to any page. |
| `host_permissions` | `https://*.youtube.com/*`, read captions from the page. |

The list is pinned by a test. There is no `activeTab`, no `tabs`, and no
`web_accessible_resources`, so no page can reach into the extension.

## Privacy

Nothing is collected.

- **No account, no server of ours, no analytics, no telemetry, no crash
  reporting.**
- **Settings are stored in your browser**, in `chrome.storage.local`, and are not
  synced anywhere, not even to your own other devices.
- **No browsing history and no identifiers**, and no tab contents beyond the
  caption data below.
- **One external host: `youtube.com`.** The extension reads the caption track of
  the video in the tab you have open, using that page's own session. The
  dictionaries are bundled, so looking a word up makes no request at all.

The caption fetch is the only request the extension makes outside itself, and a
test fails the build if another host or transport appears. See
[`TESTING.md`](TESTING.md#the-privacy-claim-is-a-check-not-a-paragraph).

The extension also ships a small number of third-party files, each named in
[`THIRD-PARTY.md`](THIRD-PARTY.md). They are local code, not requests: the coder
packages are WebAssembly that runs entirely inside the browser and sends nothing.

## Known limitations

- **About half of Korean words have no definition yet.** Korean draws on two
  unrelated sources, a graded word list and a course companion, and only the second
  glosses what it holds. Words with no definition still mark, and the hover says it
  has no definition yet.
- **Some Chinese characters have no pinyin.** Measured on a traditional track:
  26 of 295 marked tokens (8.8%) show no reading, against 21 of 294 (7.1%) on the
  same text in simplified, so traditional is only about 1.7 points worse. Of the
  26, 21 are words the dictionary does not hold at all (師, 兄, 言, 僧, 芭蕉) and
  fail identically in simplified; the remaining 5 are traditional forms (從, 裡,
  穀, 雲, 淨) whose character mapping is not in the data. Traditional words whose
  form IS in the dictionary resolve correctly (`厲害` shows `lìhai`).
- **Korean is agglutinative, so it inherits Japanese's inflection gap and wider.**
  A conjugated verb does not match its dictionary form.
- **Spaced scripts like English cannot be marked at all**, since a sentence is one
  token to a word-list matcher.
- **Inflected Japanese forms mark the dictionary headword, not the word on
  screen.** `食べました` does not match `食べる`. Kanji forms mark correctly.
- **A few Japanese words share one entry where JMdict splits homographs** (`私` is
  both わたし and あたし), so hover shows one reading. 156 spellings are affected.
- **Bilingual alignment is approximate.** Cues are matched by start time; a pair
  more than 1.5s apart is left blank.
- **Videos without captions show an error** rather than a fallback.
- **Live streams** have unstable caption timing, so seeking may not line up.
- **Transcripts are not persisted** past a browser restart. The 6 most recent
  videos are cached.

## Roadmap

| Order | Work | What it involves |
| ----- | ---- | ---------------- |
| 1 | Save words, and export to Anki | Per-word known and unknown state, saving a word as you meet it, and one click from a line to a card |
| 2 | Korean dictionary coverage | About half of Korean words have no definition, because the graded word list and the course companion are different vocabularies. A fuller Korean dictionary closes it |
| 3 | Netflix, Disney+ | A reader for each service, since neither exposes subtitles the way YouTube does |
| 4 | Ebooks, webpages | The same treatment as the streaming services |

Not planned: accounts, cross-device sync, a paid tier, mobile apps.

## Parked: audio capture

A tab-capture path exists, capturing tab audio and running a speech recogniser,
but it is behind `USE_AUDIO_CAPTURE = false` and has never been run end to end.

> ⚠️ **Turning it on also means restoring two manifest permissions.** `tabCapture`
> and `offscreen` were **removed** while the path is unreachable, because a
> permission no shipping feature uses cannot be honestly justified to a store
> reviewer. Add both back to `permissions` in `manifest.json` before setting the
> flag, or `getMediaStreamId` and `createDocument` fail with the API undefined.

The engine is a stub that emits placeholder events, so the parked path is a
pipeline test and not a transcriber.

## Licence

Our code, everything in `src/` except `src/vendor/`, plus the icons and the tests,
is **MIT**; see [`LICENSE`](LICENSE). One third-party file ships:
`src/vendor/mediabunny.js` (MPL-2.0), a generated bundle of the container library
and the AC-3 and AAC coder packages, which reads and re-encodes a local video's
audio tracks. MPL-2.0 is file-level copyleft: it obliges publishing changes to its
own files, and imposes nothing on this project. No third-party fonts or images are
bundled.

The dictionaries are **not** ours and **not** MIT. All three are share-alike
derived works:

- `src/learn/data/chinese.json`, CC-CEDICT, with HSK levels from the official MOE
  HSK 3.0 word list. CC BY-SA 4.0.
- `src/learn/data/japanese.json`, JMdict (EDRDG), with JLPT levels from an
  MIT-licensed list. CC BY-SA 4.0.
- `src/learn/data/korean.json`, the NIKL word list for levels, and Open Yonsei
  Korean Vocabulary for definitions, readings and course levels. CC BY-SA 3.0.

The licence on this project's own code does not cover any of them, and none may be
relicensed. Full attribution, source revisions and content hashes are in
[`THIRD-PARTY.md`](THIRD-PARTY.md).
