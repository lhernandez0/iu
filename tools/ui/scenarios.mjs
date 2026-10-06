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
    label: 'Nothing marked',
    note: 'No word is highlighted, as if none of them are in the list. A transcript can legitimately be plain.',
    tracks: [zh, en],
    settings: { studyLanguage: zh.languageCode, glossLanguage: en.languageCode },
    // Not a threshold above the ramp: the control only offers levels the list
    // has, so "nothing marked" cannot be expressed that way without the picker
    // showing a value it does not offer. The mock simply marks nothing.
    noMarks: true,
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
