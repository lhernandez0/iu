/**
 * Scenarios for the UI preview server (`npm run ui`).
 *
 * A scenario is a fixture plus the settings to render it with. They exist because
 * the states worth designing against are exactly the ones that are hard to reach
 * on demand in a real browser: a single-subtitle video, a transcript with nothing
 * known in it, a 30-second silence, a worker reporting an error.
 *
 * The transcripts come from the committed synthetic corpus, so the text is ours
 * and the shapes are real (per `test/synthetic/`'s convention). Nothing here is
 * derived from a live page, and nothing here is imported by the extension.
 *
 * THIS FILE IS NODE-ONLY. It reads the corpus from disk, so it must not be
 * imported by anything the browser loads — doing that produced
 * "Access to script at 'node:fs' ... blocked by CORS policy" and left the panel
 * stuck on its placeholder, with no mention of the real cause. The server
 * serialises a scenario and sends it to the page as data; the browser half is
 * `mock-worker.mjs`, which imports nothing from here.
 */

import { fixture } from '../../test/synthetic/load.mjs';

/** The committed corpus, with a fallback for a fresh clone. */
const corpus = fixture();

const track = (languageCode) =>
  corpus.tracks.find((t) => t.languageCode === languageCode) ?? corpus.tracks[0];

/** Real tracks, at most two, as the panel expects them. */
const en = track('en');
const zh = track('zh-Hans') ?? track('en');

/**
 * A Japanese track, written here because the corpus has none.
 *
 * The committed corpus is `zh-Hans` and `en` only, so there was no way to preview
 * the Japanese path at all — which is a problem now that it is the newest feature
 * and the one with open design questions (JLPT level names, kana marks, and
 * furigana if it lands). Hand-written text is the same convention `test/synthetic/`
 * uses: ours, in real shapes.
 *
 * Deliberately mixes kanji and kana. `とても` is there to prove kana marks, since
 * that was impossible until the segmenter learned the kana blocks, and a preview
 * that only showed kanji would look correct while hiding the half that used to be
 * broken.
 *
 * Short on purpose — five cues is enough to judge marks and reading. A 400-cue
 * Japanese transcript would be more faithful and no more useful for styling.
 */
const ja = {
  languageCode: 'ja',
  name: 'Japanese',
  kind: null,
  isTranslatable: true,
  segments: [
    { start: 0, duration: 2.4, text: '私は学生です。' },
    { start: 2.4, duration: 2.8, text: '日本語を勉強します。' },
    { start: 5.2, duration: 2.6, text: 'とても難しいです。' },
    { start: 7.8, duration: 2.4, text: '今日はいい天気ですね。' },
    { start: 10.2, duration: 2.6, text: 'ありがとうございました。' },
  ],
};

/** English for the Japanese track, aligned cue-for-cue so the gloss lines up. */
const jaEn = {
  languageCode: 'en',
  name: 'English',
  kind: null,
  isTranslatable: false,
  segments: [
    { start: 0, duration: 2.4, text: 'I am a student.' },
    { start: 2.4, duration: 2.8, text: 'I study Japanese.' },
    { start: 5.2, duration: 2.6, text: 'It is very difficult.' },
    { start: 7.8, duration: 2.4, text: 'Nice weather today.' },
    { start: 10.2, duration: 2.6, text: 'Thank you very much.' },
  ],
};

/** Everything the preview can render, in the order the switcher shows them. */
export const SCENARIOS = [
  {
    id: 'bilingual',
    label: 'Two languages',
    note: 'Chinese being learned, English underneath — the ordinary case.',
    tracks: [zh, en],
    settings: { studyLanguage: zh.languageCode, glossLanguage: en.languageCode },
  },
  {
    id: 'same-language',
    label: 'Same language, translated',
    note: 'English on both lines with the second machine translated. This is the state that used to be impossible: "Off" has no track to translate.',
    tracks: [en, en],
    settings: {
      studyLanguage: en.languageCode,
      glossLanguage: en.languageCode,
      glossTranslated: true,
      translateInto: 'zh-Hans',
    },
  },
  {
    id: 'study-only',
    label: 'One subtitle',
    note: 'No gloss, so the translation controls are hidden entirely.',
    tracks: [zh],
    settings: { studyLanguage: zh.languageCode, glossLanguage: null },
  },
  {
    id: 'untranslatable',
    label: 'Gloss that cannot be translated',
    note: 'The second track is human-authored, so YouTube refuses to translate it. The controls disable and say why instead of appearing to work.',
    tracks: [zh, { ...en, isTranslatable: false }],
    settings: {
      studyLanguage: zh.languageCode,
      glossLanguage: en.languageCode,
      glossTranslated: true,
      translateInto: 'ko',
    },
  },
  {
    id: 'no-marks',
    label: 'High threshold',
    note: 'Marking only from level 3, so only the rarer words are highlighted. A threshold above every level is no longer expressible — the list is real now.',
    tracks: [zh, en],
    settings: { studyLanguage: zh.languageCode, glossLanguage: en.languageCode, threshold: 3 },
  },
  {
    id: 'long-silence',
    label: 'A long silence',
    note: 'The playhead sits in a 30-second gap. The finished line keeps its highlight and dims, which is the bug that blinked off on every cue.',
    tracks: [zh, en],
    settings: { studyLanguage: zh.languageCode, glossLanguage: en.languageCode },
    startInGap: true,
  },
  {
    id: 'long-line',
    label: 'Overlong line',
    note: 'A cue far longer than any real one, to see wrapping and row height at their worst.',
    tracks: [zh, en],
    settings: { studyLanguage: zh.languageCode, glossLanguage: en.languageCode },
    stretchLongestCue: 400,
  },
  {
    id: 'japanese',
    label: 'Japanese',
    note: 'JLPT, so the level control reads N5 to N1 and the marks use kana as well as kanji. とても is the case that could not be marked at all until the segmenter learned the kana blocks.',
    tracks: [ja, jaEn],
    settings: { studyLanguage: 'ja', glossLanguage: 'en', listId: 'jlpt' },
  },
  {
    id: 'error',
    label: 'Error state',
    note: 'What the panel shows when the extension cannot reach the video at all.',
    tracks: [zh],
    settings: {},
    error: 'No YouTube tab is active.',
  },
  {
    id: 'no-captions',
    label: 'No captions',
    note: 'The video loaded but has no subtitle tracks.',
    tracks: [],
    settings: {},
  },
];

/** @param {string} id @returns {object} */
export function scenarioById(id) {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? SCENARIOS[0];
}

/**
 * Labels and notes only, for the switcher.
 *
 * The transcript payloads are deliberately excluded: they are megabytes of cues,
 * and the switcher only needs to draw links.
 */
export const SCENARIO_INDEX = SCENARIOS.map(({ id, label, note }) => ({ id, label, note }));
