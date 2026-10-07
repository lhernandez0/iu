# Chrome Web Store Listing — IU

> Last Updated: 2026-10-07
> **Status: draft.** Nothing here has been submitted. Kept current so publishing is
> a copy-paste rather than a scramble.

## Store Listing

**Extension Name**
IU

<!-- Matches manifest.json "name". 2 characters. The store field allows 75. -->

**Short Description**

Turn any video into a Chinese or Japanese lesson: unknown words marked, definitions on hover.

<!-- 93 characters, within the 132 limit. MUST match manifest.json
     "description" exactly — the store reads that field, and a mismatch between
     this file and the manifest is the kind of thing that is only noticed at
     submission. The manifest test asserts the two files agree, so this cannot
     drift. -->

**Detailed Description**

Understand the video you're watching.

You know the feeling: there's a show or a channel you want to watch, and you can
follow maybe two words in three. Every sentence has a hole in it, and looking the
words up means leaving the video — so you stop watching, or you watch and
understand nothing.

IU fills the holes. The subtitles sit in a panel beside the video with every word
you don't know picked out. Hover one and it tells you what it means. You keep
watching, and the video is teaching you the whole time.

Free, open source, no account. Chinese and Japanese, on YouTube.

WHAT YOU GET IN ONE CLICK

Click the toolbar icon on any video and the panel opens with the subtitles in it:

- The words you haven't learned yet are **underlined, in a colour for how hard
  they are**. The words you already know stay plain — so one glance tells you how
  much of a line is actually within reach.
- **Hover any word** for its reading and meaning. Chinese gives you pinyin,
  Japanese gives you kana.
- **A second subtitle line** underneath, if you want it: another track, or a
  machine translation of the same one, clearly tagged as such.
- **The transcript follows the video** as it plays. Click any line to jump there.
- **Return to a video and it's still loaded.**

A WORD LIST THAT KNOWS WHAT YOU'RE STUDYING

Choose HSK for Chinese or JLPT for Japanese, and set the level you're working at.
Everything at or above it is marked; everything you already know gets out of the
way.

The lists keep their own level names, so JLPT reads N5 through N1 and HSK counts
1 upward — the order each test actually uses, not a number we invented. And when
two lists disagree about a word — HSK 2.0 and HSK 3.0 frequently do — you see both,
because both are somebody's syllabus.

BUILT FOR WATCHING, NOT FOR COLLECTING

No account. No server. No sign-in, no sync, no analytics, no tracking of what you
watch. Nothing leaves your browser, and there is nothing of yours on a machine of
ours to leak.

YOUR PRIVACY IS THE PRODUCT WORKING, NOT A PROMISE

IU reads the subtitles of the video in the tab you have open and nothing else. It
does not read your other tabs, your history, or your Google account — the
permissions it asks for are four, and the store reason for each one is written out
in plain English. It talks to no server except YouTube's own, the same one that
serves the subtitles you can already see on screen.

HOW TO START

1. Add the extension and open a video on YouTube.
2. Click the toolbar icon — the panel opens beside the video.
3. Pick your subtitle language, then your word list and your level.
4. Watch. Hover any marked word. Click a line to jump to it.

PROBABLY NOT FOR YOU IF…

- **You can't read the script yet.** IU assumes you can read the characters and
  want to build vocabulary. It won't teach you the alphabet.
- **You want a course.** This doesn't teach grammar or give you lessons. It
  explains the words in whatever you choose to watch.
- **You want to save words and review them later.** Not yet — IU is a reader. See
  the note below for what's coming.

HONEST ABOUT WHAT IT DOESN'T DO YET

Word saving, flashcard export, and grammar notes are not here. The reader works
and it works well; the study loop comes next.

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
     instead. -->

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

<!-- Verified by reading the code rather than by intent. The only network requests
     the extension makes are (a) to its own bundled dictionary files inside the
     extension, and (b) to YouTube's caption endpoint, on the video page's own
     origin and with the page's own session — the same request the page's subtitle
     button makes. There is no analytics, no telemetry, no remote configuration,
     and no server of ours. -->

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
- [ ] **ZIP excludes `node_modules/`, `.git/`, `.env`, `docs/`, `test/`, `tools/`** —
      not staged. The loaded dev tree is ~78 MB because of `node_modules` and
      `docs`; the files that actually ship are ~4.6 MB, of which 4.2 MB is the two
      bundled dictionaries. A store ZIP must be built from the shipping set, not
      from the repository root.
- [ ] **Privacy policy URL live** — optional here (no data collection), not written.
- [ ] **Version bumped in `manifest.json`** — 0.1.0 is the development version.

## Language Claim, and Why It Is Worded Carefully

The description says **Chinese and Japanese** and names **YouTube**. Both are
deliberate and both should stay accurate:

- The video source sits behind a provider seam, so another site is a data addition
  rather than a rewrite. It is still **one provider today**, and the host
  permission covers YouTube alone. Saying "any video site" would be false, and the
  store can test a claim like that.
- The dictionaries are Chinese (HSK) and Japanese (JLPT). Adding a language means
  adding a word list and a dictionary document — no code change — but a language
  that has not been added is not supported, and an extension that claimed "any
  language" would fail the first reviewer who tried Spanish.

"From video" is used rather than "from YouTube" where the sentence allows, because
that is the direction of travel and it is not an overclaim — the subtitles really
are read from the video. Where the source matters to a permission justification,
YouTube is named plainly.
