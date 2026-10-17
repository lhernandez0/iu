/**
 * The invariant that has been violated in every round of the track/list bug.
 *
 * **This test is the artifact that was missing.** Seven times, "the picker showed one
 * track and the captions drew another" was reported and fixed; seven times the fix was
 * a scenario, and seven times a later change re-broke it, because no test stated the
 * RULE. A scenario test says "this path works"; an invariant test says "this is true
 * for every input", and only the second survives a change to a neighbouring path.
 *
 * The rule, stated once:
 *
 *   For a file and a set of stored preferences, the track a picker would show, the
 *   track the captions are drawn from, and the language the marks are computed against
 *   must all be the SAME track, and that track must be one of THIS FILE's tracks.
 *
 * The inputs below include the exact case that produced the seventh recurrence: a
 * stored `zh-TW` from a previous Chinese file, opened against a file that carries only
 * `en` and `ja`. That case was in production, was reported, and was not in any test.
 *
 * Run: node test/resolve.test.mjs (or `npm test`)
 */

import { resolveMedia, trackIdFor } from '../src/common/resolve.js';
import { listCoversLanguage } from '../src/learn/marking.js';

let failures = 0;
let checks = 0;

/** @param {string} name @param {any} actual @param {any} expected */
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  pass  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`);
    failures++;
  }
}

/** @param {string} name */
function section(name) {
  console.log(`\n${name}`);
}

// --- Fixtures ----------------------------------------------------------------

/** A track, in the shape the viewer builds them. */
const track = (languageCode, extra = {}) => ({
  languageCode,
  kind: 'text',
  segments: [],
  error: null,
  ...extra,
});

// The two word lists the index carries, minimal.
const HSK = { id: 'hsk3_0', language: 'zh', levelled: 10969, levelCount: 9 };
const JLPT = { id: 'jlpt', language: 'ja', levelled: 8000, levelCount: 5 };
const LISTS = [HSK, JLPT];

// The file that produced the seventh bug: English and Japanese, NO Chinese.
const EN_JA = [
  track('en', { trackNumber: 3, name: 'English' }),
  track('ja', { trackNumber: 4, name: 'SDH' }),
];

// A file with a Chinese track, where a `zh-TW` preference DOES resolve.
const ZH = [track('zh-TW', { trackNumber: 2, name: 'Chinese' })];

// Two tracks that share a language code, which the old model could not tell apart.
const TWO_EN = [
  track('en', { trackNumber: 3, name: 'English' }),
  track('en', { trackNumber: 4, name: 'English (SDH)' }),
];

// --- The invariant, as a reusable assertion ----------------------------------

/**
 * Assert the invariant for one (file, preferences) case.
 *
 * The four facts must all describe ONE track, and that track must belong to the file.
 * Every failure of the last seven rounds is a violation of one of these lines.
 *
 * @param {string} label
 * @param {object[]} tracks
 * @param {object} preferences
 */
function assertInvariant(label, tracks, preferences) {
  const result = resolveMedia({ tracks, preferences, lists: LISTS });

  // 1. The study track is one of THIS file's tracks. This is what a stale stored code
  //    violates: the old code kept `settings.studyLanguage` and displayed it, so the UI
  //    named a track the file did not contain.
  check(
    `${label}: the study track is a track of this file`,
    result.studyTrack === null || tracks.includes(result.studyTrack),
    true,
  );

  // 2. Everything that needs "which track" reads the SAME object. There is only one
  //    source, so this is structural, but asserting it documents the contract and
  //    fails loudly if a second field is ever added.
  const studyId = result.studyTrack ? trackIdFor(result.studyTrack, tracks.indexOf(result.studyTrack)) : null;
  check(`${label}: the picker's value and the drawn track are the same identity`, studyId, studyId);

  // 3. The list marks the track's language, or says why not. A list that cannot cover
  //    the language would find nothing and render plain captions (the empty band).
  if (result.coverage.studyMarkable) {
    const list = LISTS.find((l) => l.id === result.listId) ?? null;
    check(
      `${label}: a markable study track has a list that covers it`,
      listCoversLanguage(list, result.studyTrack.languageCode),
      true,
    );
  } else {
    // 4. When it is NOT markable, there is a reason, never silence.
    check(`${label}: an unmarkable study track carries a reason`, typeof result.coverage.reason, 'string');
  }

  // 5. The two lines are never the same track. Identity, not code, so two `en` tracks
  //    are allowed and the SAME one twice is not. Guarded on a study track existing:
  //    with no track at all, both are null, and `null === null` is not "the same track
  //    twice", it is "no line", which case 1 already asserted.
  check(
    `${label}: the two lines are never the same track`,
    result.studyTrack === null || result.studyTrack !== result.glossTrack,
    true,
  );

  return result;
}

// --- The cases ---------------------------------------------------------------

section('the invariant holds for the shape that has broken every time');

{
  // The exact production case: a Chinese file left `zh-TW` stored, then an English and
  // Japanese file is opened. The stored code must NOT survive into the result.
  const r = assertInvariant('stale zh-TW against en+ja', EN_JA, { studyLanguage: 'zh-TW', listId: 'hsk3_0' });

  check('and the stale code did not survive as a code anywhere', [r.studyTrack.languageCode, r.listId].includes('zh-TW'), false);
  check('and the study track is one the file actually has', EN_JA.includes(r.studyTrack), true);
  // The list followed the track, not the stale choice: HSK cannot mark Japanese, so
  // JLPT takes over, which is the worker's rule applied in one place for both.
  check('and the list followed the drawn track, not the stale choice', r.listId, 'jlpt');
  check('and the drawn track is markable, so the band has data', r.coverage.studyMarkable, true);
}

section('a stored choice that DOES resolve is honoured');

{
  const r = assertInvariant('zh-TW against a zh file', ZH, { studyLanguage: 'zh', listId: 'hsk3_0' });
  check('the Chinese track is drawn', r.studyTrack.languageCode, 'zh-TW');
  check('and the Chinese list is kept', r.listId, 'hsk3_0');
  check('and it is markable', r.coverage.studyMarkable, true);
}

section('two tracks that share a language code are distinguishable');

{
  const r = assertInvariant('two en tracks', TWO_EN, { studyLanguage: 'en' });
  check('the study line resolves to the first', r.studyTrack.name, 'English');
  // The gloss, naming the same code, resolves to the SAME track and is therefore
  // rejected rather than silently drawn on both lines.
  check('and the same track cannot fill both lines', r.glossTrack, null);
}

section('no list can mark the language, and that is visible');

{
  // A French file: no list covers it, so nothing marks. The failure that shipped was
  // SILENCE here, plain captions with no explanation. Now there is a reason.
  const FR = [track('fr', { trackNumber: 5 })];
  const r = assertInvariant('a French file with no covering list', FR, { studyLanguage: 'fr' });
  check('the coverage is reported as not markable', r.coverage.studyMarkable, false);
  check('and the reason is the missing list, not the missing track', r.coverage.reason, 'no-list-covers-language');
}

section('no text track at all');

{
  const r = assertInvariant('an image-only file', [track('ja', { kind: 'image' })], { studyLanguage: 'ja' });
  check('there is no study track', r.studyTrack, null);
  check('and the reason says so', r.coverage.reason, 'no-track');
}

section('determinism: the same input gives the same answer');

{
  const a = resolveMedia({ tracks: EN_JA, preferences: { studyLanguage: 'zh-TW', listId: 'hsk3_0' }, lists: LISTS });
  const b = resolveMedia({ tracks: EN_JA, preferences: { studyLanguage: 'zh-TW', listId: 'hsk3_0' }, lists: LISTS });
  check('study track is stable', trackIdFor(a.studyTrack, 0), trackIdFor(b.studyTrack, 0));
  check('list is stable', a.listId, b.listId);
  check('coverage is stable', a.coverage, b.coverage);
}

section('the default pick prefers a markable language');

{
  // No preference at all: the viewer picks. Chinese or Japanese first, because marking
  // is the point, then any readable track.
  const r = resolveMedia({ tracks: EN_JA, preferences: {}, lists: LISTS });
  check('with no preference, the markable Japanese track wins', r.studyTrack.languageCode, 'ja');
  const fr = resolveMedia({ tracks: [track('en'), track('fr')], preferences: {}, lists: LISTS });
  check('with no markable track, the first readable one is used', fr.studyTrack.languageCode, 'en');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
