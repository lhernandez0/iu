# Chrome Web Store Listing — IU Language Companion

> Last Updated: 2026-10-07
> **Status: draft.** Nothing here has been submitted. Kept current so publishing is
> a copy-paste rather than a scramble.

## Store Listing

**Extension Name**
IU Language Companion

<!-- Matches manifest.json "name". 23 characters, inside the store's 75 limit.
     The descriptor is not decoration: "IU" alone collides with a K-pop artist on
     a store search, and a bare brand is neither findable nor unambiguous. It names
     no language on purpose — Korean is next and the name should not expire when it
     lands. -->

**Short Description**

A Chinese and Japanese dictionary for video: words you don't know marked, definitions on hover.

<!-- 94 characters, within the 132 limit. MUST match manifest.json
     "description" exactly — the store reads that field, and a mismatch between
     this file and the manifest is the kind of thing that is only noticed at
     submission. The manifest test asserts the two files agree, so this cannot
     drift. -->

**Detailed Description**

A dictionary for the video you are watching.

The subtitles become text you can look words up in. Every word you do not know yet
is picked out and explained, right beside the video. Chinese and Japanese, on
YouTube, in Chrome, Edge, Brave or Firefox.

EVERY WORD YOU DON'T KNOW, MARKED

Pick HSK for Chinese or JLPT for Japanese, set the level you are working at, and
the words you have not met yet are picked out in the transcript. Your known words
fade into the background, so you can see at a glance how much of a sentence is
actually in reach. Each list names its own levels — JLPT reads N5 to N1, HSK reads
1 upward — in the order that language really counts.

LOOK UP ANYTHING WITHOUT LEAVING THE VIDEO

Hover a word for its reading and meaning. Chinese shows pinyin, Japanese shows
kana, and a word appears under every list that knows it — HSK 2.0 and HSK 3.0
disagree, and both are true. Words that sit outside the graded lists are still
defined; they simply carry no level.

TWO SUBTITLES AT ONCE

Your target language with a second line underneath — another subtitle track, or a
machine translation of the same one. Translated lines are tagged, so you always
know which you are reading.

NEVER LOSE YOUR PLACE

The transcript follows playback, and clicking a line jumps the video to it. Return
to a video and it is still there, waiting.

TAKE IT AWAY

Export what you watched as plain text or an SRT subtitle file.

HOW TO USE IT

1. Install the extension and open a video.
2. Click the extension icon to open the side panel.
3. Choose your subtitle language, then your word list and level.
4. Hover any marked word for its definition. Click any line to seek.

PRIVACY

The extension collects nothing. There is no analytics, no account, and no server.
Your settings are stored in your own browser. See the privacy section below for
detail.

**Category**
Productivity

<!-- Not a perfect fit — the store offers no "Education" — but Productivity is
     where study and reading aids sit, and it is more accurate than the
     alternatives (Accessibility describes reading *assistance*, which this is
     not). -->

**Single Purpose**

Reads a video's subtitles in the side panel as text marked up with dictionary
definitions and word-list levels.

<!-- One sentence, narrow. The store rejects extensions whose stated purpose does
     not cover what the permissions are for; every permission below serves this
     sentence and nothing else. -->

**Primary Language**
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 4 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 5 | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

<!-- Status options: ⬜ Not created | 🟡 Needs update | ✅ Ready -->

### Screenshot Notes

Shot 4 and 5 are the ones that matter — 1 to 3 are the conventional walkthrough.
All of them should show a **real video with real subtitles**, not a mock, because
the marks only look like anything on real text.

1. **A Chinese transcript with marks visible.** The core product in one image.
   Should show marks at more than one level, so the colour ramp is legible.
2. **A hover showing a definition.** The popover open over a marked word, with the
   reading and the level badge visible. This is the feature that makes the marks
   mean something.
3. **Two subtitle tracks.** Bilingual reading, with the machine-translation tag
   visible on a translated line if possible — it is a claim in the description.
4. **The level control, showing JLPT N5–N1.** Proves the per-list level naming is
   real, and that the list you pick determines the levels offered.
5. **Japanese, with kana words marked.** Deliberately: much of Japanese is written
   in kana and nowhere else, and an extension that only marked kanji would look
   the same in a screenshot that happened to be kanji-only.

Do NOT use a screenshot of the side panel against a blank or mock page. The whole
claim is that it works on a real video, and a reviewer can tell.

## Permissions Justification

<!-- Every permission needs a plain-English reason tied to a user-facing feature.
     "Required for the extension to work" is rejected. Each one below names the
     feature that would break without it. -->

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Saves your preferences — subtitle languages, word list, level, text size and view — in your own browser. Without it the extension would forget every choice each time you closed it. Nothing is synced or transmitted. |
| `sidePanel` | permissions | The transcript is displayed in the browser's side panel, beside the video. This is the entire user interface. |
| `scripting` | permissions | Injects the small script that reads a video page's player data, so the extension knows which subtitle tracks the video offers and where playback is. Injected only into a video page you have open, and only when the panel asks for it. |
| `webNavigation` | permissions | Detects when a video page navigates to a different video, so the transcript is re-read for the video now on screen rather than continuing to show the previous one's. Without it the panel would show stale subtitles after switching videos. |
| `contextMenus` | permissions | Adds **Open video files…** to the extension's own toolbar menu, which is how a local video is opened. It adds one item to the menu on the extension's icon and nothing anywhere else — the page right-click menu is untouched, and it grants no access to any page or tab. |
| `https://*.youtube.com/*` | host_permissions | Reads the subtitle tracks the page has already loaded. The extension does not access any other site, and only reads caption and player data — never your Google account, your viewing history, or your browsing. |

<!-- NOT REQUESTED, and why, because the store asks about this:

     `tabCapture` and `offscreen` are absent. The extension contains a parked
     audio-capture path that would need them, but it is unreachable behind a build
     flag, and a permission no shipping feature uses cannot be honestly justified.
     If that path is ever turned on, both come back and this table gains two rows.

     `activeTab` is absent because it cannot work here — it grants access only on a
     direct user gesture, and the panel reads the tab from a control inside itself.
     `host_permissions` is the correct mechanism.

     `tabs` is absent. `chrome.tabs.query` returns the tab's `id` without it; only
     `url` and `title` are redacted, and those are read through the content script
     instead. A consequence worth stating: the toolbar menu's item reads "Open
     video files…" rather than naming the video, because naming it would need this
     permission.

     `contextMenus` IS requested, and IS needed — the API does not exist without
     it, for an action-context item exactly as much as for a page-context one. This
     was originally believed to be free and that was wrong: the menu item was
     silently absent until the permission was added. `test/manifest.test.mjs` now
     pins the whole permission list so a future change has to be deliberate. -->

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

<!-- Verified by a test on the shipped source, not by intent: `npm test` fails if a
     request to any host other than youtube.com appears, if a transport other than
     fetch is used, or if storage.sync is reached for. The only network requests
     the extension makes are (a) to its own bundled dictionary files inside the
     extension, and (b) to YouTube's caption endpoint, on the video page's own
     origin and with the page's own session — the same request the page's subtitle
     button makes. There is no analytics, no telemetry, no remote configuration,
     and no server of ours. See the privacy section of TESTING.md. -->

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | — | No |
| Health info | No | No | — | No |
| Financial info | No | No | — | No |
| Authentication info | No | No | — | No |
| Personal communications | No | No | — | No |
| Location | No | No | — | No |
| Web history | No | No | — | No |
| User activity | No | No | — | No |
| Website content | No | No | — | No |

<!-- "Website content" is No deliberately, and it is the row worth reading twice.

     The extension DOES read the subtitles of the video you are watching — but only
     for the tab you have open, only in that tab's own page, and nothing is sent
     anywhere. It is not collected: it is not stored beyond a local cache of the
     transcript you are reading, it does not leave your browser, and we have no
     server that could receive it. Declaring Yes here would be inaccurate in the
     other direction and would imply a data flow that does not exist. -->

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's single purpose
- [x] Data is NOT used to determine creditworthiness or for lending purposes

### Privacy Policy

**Not yet published.** A privacy policy URL is required by the store if an
extension collects data; this one does not, so it is optional. It is still worth
publishing one for an extension that reads a page's content at all, because it
answers the question a suspicious user actually has. When written it should say,
in the user's language rather than a lawyer's: nothing leaves your browser, there
is no account, there is no server, and the only network requests are for the
subtitles of the video you are already watching.

## Version History

| Version | Date | Summary |
|---------|------|---------|
| 0.1.0 | — | Not submitted. Captions phase: reading YouTube subtitles in the side panel with word-list marking, hover definitions, bilingual tracks, and export. |

<!-- No entry above is a real submission. The table exists so the first real one
     has somewhere to go. -->

## Pre-Publish Checklist

From the store review checklist. The ones that apply to this extension:

- [ ] **Every permission has a specific justification** — done above; re-read it
      against `manifest.json` before submitting, since the two drift.
- [x] **Icons are real files at correct dimensions** — 16/32/48/128 verified.
- [ ] **At least one screenshot at 1280×800 or 640×400** — none taken yet.
- [x] **ZIP excludes `node_modules/`, `.git/`, `docs/`, `test/`, `tools/` and every
      dotfile** — scripted. `make release` stages the shipping set, lints it with
      `web-ext lint`, zips it and then asserts the archive contains exactly what
      the Makefile declares. The loaded dev tree is ~78 MB because of
      `node_modules` and `docs`; the package is ~4.6 MB, of which 4.2 MB is the two
      bundled dictionaries. One ZIP serves both stores.
- [ ] **Privacy policy URL live** — optional here (no data collection), not written.
- [ ] **Version bumped in `manifest.json`** — 0.1.0 is the development version.

## Language Claim, and Why It Is Worded Carefully

The description says **Chinese and Japanese**, names **YouTube**, and does not say
"any video". All three are deliberate:

- **"Any video" is gone.** It was in the short description and the first line of
the detailed one, and it was FALSE — `host_permissions` is `https://*.youtube.com/*`.
The video source sits behind a provider seam, so another site is a registry entry
plus a content script rather than a rewrite, but one provider is implemented today
and a store can test a claim like that.
- **Only the languages that work are named.** Chinese (HSK) and Japanese (JLPT)
ship. **Korean is planned and is deliberately not named in the listing**, because
it is not a data addition — Hangul is outside the segmenter's character class, so
it needs code before a dictionary would help. An extension that claimed "any
language" would fail the first reviewer who tried Spanish.
- **"Dictionary", not "lesson".** This is a dictionary that marks what you do not
know, not a course. The data agrees — 88% of Chinese entries carry more than one
sense, and Japanese carries 50 parts of speech; a lesson product would not need
either.
- **YouTube is named wherever a permission has to be justified.** The seam is a
reason to expect growth, not a claim about today.
