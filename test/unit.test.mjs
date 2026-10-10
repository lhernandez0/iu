/**
 * Unit tests for the pure logic in src/common/transcript.js.
 *
 * These are the functions with no browser dependency at all, so they carry the
 * full weight of the alignment guarantee: the whole safety property of dual
 * subtitles is that a badly out-of-sync second track is left blank rather than
 * paired with the wrong line. A silent failure here would put a plausible but
 * wrong translation on every row, which is worse than showing nothing.
 */

import { formatTimestamp, formatSrtTime, toPlainText, toSrt, findActiveIndex, alignSecondary } from '../src/common/transcript.js';
import { defaults, SETTINGS, byAudience, audienceProblems, SURFACES, forSettingsView, forTranscriptBar } from '../src/common/settings.js';

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

/** @param {number} start @param {string} text @param {number} [duration] */
const seg = (start, text, duration = 2) => ({ start, duration, text });

// --- formatTimestamp ---------------------------------------------------------

section('formatTimestamp');

check('zero', formatTimestamp(0), '0:00');
check('seconds pad', formatTimestamp(5), '0:05');
check('under a minute', formatTimestamp(59), '0:59');
check('rolls to a minute', formatTimestamp(60), '1:00');
check('minutes and seconds', formatTimestamp(75), '1:15');
check('just under an hour', formatTimestamp(3599), '59:59');
check('rolls to an hour', formatTimestamp(3600), '1:00:00');
check('hours, minutes, seconds', formatTimestamp(3725), '1:02:05');
check('hours pad the minutes', formatTimestamp(3605), '1:00:05');
check('fractional seconds floor', formatTimestamp(75.9), '1:15');
check('negative clamps to zero', formatTimestamp(-5), '0:00');

// --- formatSrtTime -----------------------------------------------------------

section('formatSrtTime');

check('zero', formatSrtTime(0), '00:00:00,000');
check('milliseconds', formatSrtTime(1.5), '00:00:01,500');
check('rounds to the nearest ms', formatSrtTime(1.2345), '00:00:01,235');
check('minutes', formatSrtTime(75), '00:01:15,000');
check('hours', formatSrtTime(3661.5), '01:01:01,500');
check('negative clamps', formatSrtTime(-1), '00:00:00,000');

// --- toPlainText / toSrt -----------------------------------------------------

section('export formatting');

check('plain text is one line per segment', toPlainText([seg(0, 'a'), seg(2, 'b')]), 'a\nb');
check('empty input', toPlainText([]), '');

const srt = toSrt([seg(0, 'Hello'), seg(2, 'World', 3)]);
check('srt is numbered from one', srt.startsWith('1\n'), true);
check('srt has the arrow line', srt.includes('00:00:00,000 --> 00:00:02,000'), true);
check('srt uses the real duration', srt.includes('00:00:02,000 --> 00:00:05,000'), true);
check('srt includes both texts', srt.includes('Hello') && srt.includes('World'), true);
// A zero-length cue is technically valid but unhelpful; one second is a guess,
// not a fact, and worth pinning so it does not silently change.
check('a missing duration is given one second', toSrt([{ start: 0, text: 'x', duration: 0 }]).includes('00:00:00,000 --> 00:00:01,000'), true);

// --- findActiveIndex ---------------------------------------------------------

section('findActiveIndex');

const timeline = [seg(0, 'a', 2), seg(10, 'b', 2), seg(20, 'c', 2)];

check('before the first cue', findActiveIndex(timeline, -1), -1);
check('at the very start', findActiveIndex(timeline, 0), 0);
check('inside the first cue', findActiveIndex(timeline, 1), 0);
check('at a cue boundary belongs to the new cue', findActiveIndex(timeline, 10), 1);
check('inside the second cue', findActiveIndex(timeline, 10.5), 1);
// A gap between cues belongs to the line that just finished, NOT to nothing.
//
// This used to return -1, and that was a real bug rather than a design choice:
// cue times do not tile the timeline, so after every single line the highlight
// blinked off, and the Live view, which shows only the active row, went
// completely blank between every pair of lines.
check('in a gap after a cue, the finished line still holds', findActiveIndex(timeline, 5), 0);
check('inside the last cue', findActiveIndex(timeline, 21), 2);
check('past the end holds the last cue', findActiveIndex(timeline, 999), 2);
check('empty transcript', findActiveIndex([], 5), -1);
check('a single cue', findActiveIndex([seg(0, 'only', 1)], 0.5), 0);

// --- alignSecondary: the safety property -------------------------------------

section('alignSecondary, the safe cases');

check(
  'identical timings pair one to one',
  alignSecondary([seg(0, 'a'), seg(5, 'b')], [seg(0, 'A'), seg(5, 'B')]),
  ['A', 'B'],
);

check(
  'a finer-grained second track still pairs by nearest start',
  alignSecondary([seg(0, 'a'), seg(4, 'b')], [seg(0, 'A'), seg(2, 'A2'), seg(4, 'B'), seg(6, 'B2')]),
  ['A', 'B'],
);

check('a sparse second track leaves gaps blank', alignSecondary([seg(0, 'a'), seg(4, 'b'), seg(8, 'c')], [seg(4, 'B')]), ['', 'B', '']);

check('no second track means all blank', alignSecondary([seg(0, 'a'), seg(4, 'b')], []), ['', '']);
check('no primary means no rows', alignSecondary([], [seg(0, 'A')]), []);

section('alignSecondary, the safety property');

// Each of these must produce blanks. A wrong pairing here is the failure mode
// that matters: the panel would show a confident, incorrect translation.
check('a cue far in the future is not adopted', alignSecondary([seg(10, 'a')], [seg(16, 'A')]), ['']);
check('a cue far in the past is not adopted', alignSecondary([seg(10, 'a')], [seg(2, 'A')]), ['']);
check(
  'a whole track offset by a minute lines up with nothing',
  alignSecondary([seg(0, 'a'), seg(10, 'b')], [seg(60, 'A'), seg(70, 'B')]),
  ['', ''],
);

section('alignSecondary, tolerance boundary');

// The threshold is 1500ms. Pinning both sides of it means a change to the
// constant is a deliberate act rather than an accident.
const atLimit = alignSecondary([seg(10, 'a')], [seg(11.5, 'A')]);
const pastLimit = alignSecondary([seg(10, 'a')], [seg(11.6, 'A')]);
check('exactly at the limit pairs', atLimit, ['A']);
check('just past the limit does not', pastLimit, ['' ]);
check('the limit is configurable', alignSecondary([seg(10, 'a')], [seg(16, 'A')], 10_000), ['A']);

section('alignSecondary, no cue is used twice');

// A single secondary cue should not be copied onto several primary rows just
// because it happens to be the nearest for each of them.
const reused = alignSecondary([seg(0, 'a'), seg(1, 'b'), seg(2, 'c')], [seg(0, 'ONLY')]);
check('one secondary cue fills at most one row', reused.filter((s) => s !== '').length, 1);

section('alignSecondary, shape guarantees');

const longPrimary = [seg(0, 'a'), seg(1, 'b'), seg(2, 'c'), seg(3, 'd')];
check('output length always matches the primary', alignSecondary(longPrimary, [seg(0, 'A')]).length, longPrimary.length);
check('output is always strings', alignSecondary(longPrimary, []).every((s) => typeof s === 'string'), true);

section('settings defaults are copied, not shared');

{
  // A default that is an object is a single object living in the settings
  // module, so handing it out unchanged gives every caller, and every service
  // worker booted in one test process, the SAME reference. Writing to it then
  // changes the default for everyone who reads it afterwards.
  //
  // This was not hypothetical: the per-list threshold memory is an object
  // default, and mutating it carried one test's chosen level into the next
  // worker's settings. The symptom was a level appearing in a list nobody had
  // chosen, far from the cause. Scalars are copied by value and so never showed
  // it, which is exactly why it is worth a guard of its own.
  const first = defaults();
  const second = defaults();
  check('two calls do not return the same object', first === second, false);

  const objectKeys = SETTINGS.filter((s) => s.default && typeof s.default === 'object').map((s) => s.id);
  check('there is at least one object-valued default to guard', objectKeys.length > 0, true);

  const shared = objectKeys.filter((key) => first[key] === second[key]);
  check('and none of them is shared between calls', shared, []);

  // The real failure: writing to one copy must not reach the other.
  for (const key of objectKeys) first[key].__probe = true;
  const leaked = objectKeys.filter((key) => second[key].__probe !== undefined);
  check('writing to one copy does not reach another', leaked, []);
}

section('every setting declares which surfaces show it');

{
  // `audience` is what lets the side panel and the video viewer render from ONE
  // registry instead of keeping a list each. A setting with a wrong audience is
  // invisible on a surface that needs it, which looks like a missing control in
  // the renderer, so the failure is a long way from the cause. Hence a guard on
  // the definitions themselves rather than only on a rendered screen.
  check('no definition has a missing or unknown audience', audienceProblems(), []);
  check('the known surfaces are the two applications', SURFACES, ['panel', 'viewer']);

  // The two properties `byAudience` promises: a surface never receives a setting
  // it was not tagged for, and it does receive every one it was.
  for (const surface of SURFACES) {
    const shown = byAudience(surface);
    const foreign = shown.filter((s) => !s.audience.includes(surface)).map((s) => s.id);
    check(`nothing foreign reaches "${surface}"`, foreign, []);

    const expected = SETTINGS.filter(
      (s) => !s.hidden && s.audience.includes(surface),
    ).map((s) => s.id);
    check(`every ${surface} setting is offered to it`, shown.map((s) => s.id), expected);
  }

  // `hidden` means "no control yet", so a surface must never render one.
  for (const surface of SURFACES) {
    const hiddens = byAudience(surface).filter((s) => s.hidden).map((s) => s.id);
    check(`no hidden setting is rendered on "${surface}"`, hiddens, []);
  }

  // Reading and marks apply BOTH places, the captions are drawn with the same
  // renderer, so a viewer that could not set the reading placement would be
  // showing an annotation it had no control over.
  //
  // Checked on the DEFINITION rather than through `byAudience`, because
  // `markStyle` is still `hidden`, it is tagged for both surfaces and will be
  // rendered once the settings view exists, and `byAudience` filters hidden
  // settings out by design. Asserting through `byAudience` here would be
  // asserting the flag, not the audience.
  for (const id of ['romaji', 'markStyle', 'toneStyle']) {
    const definition = SETTINGS.find((s) => s.id === id);
    check(`"${id}" is tagged for the viewer`, definition.audience.includes('viewer'), true);
    check(`and for the panel`, definition.audience.includes('panel'), true);
  }
  check('"romaji" is live on the viewer already (not hidden)', byAudience('viewer').some((s) => s.id === 'romaji'), true);

  // And the transcript-only settings must NOT leak into the viewer.
  for (const id of ['view', 'layout', 'studyTranslated']) {
    check(`"${id}" stays out of the viewer`, byAudience('viewer').some((s) => s.id === id), false);
  }
}

section('the video settings');

{
  const reader = byAudience('viewer').map((s) => s.id).sort();
  // The LIVE reader settings. `listId`, `threshold`, `studyLanguage` and
  // `glossLanguage` are SHARED with the panel rather than duplicated: a learner
  // studying HSK 2.0 with a Chinese track is studying HSK 2.0 with a Chinese track
  // whether the text is beside the video or over it, so a second copy of those
  // preferences would be a split nobody would think to check for.
  check(
    'the viewer renders exactly its own live settings',
    reader,
    [
      'captionPlacement',
      'captionSize',
      'captionsOn',
      'defaultSpeed',
      'difficulty',
      'glossLanguage',
      'listId',
      'markStyle',
      'rememberPosition',
      'romaji',
      'studyLanguage',
      'threshold',
      'toneStyle',
    ].sort(),
  );

  // Captions ON by default is a product decision, not a detail: this is a
  // learning tool, so the transcript should be working on first open. Asserted
  // because flipping it back is a one-character change that would be easy to make
  // without noticing it is a decision.
  check('captions default ON', defaults().captionsOn, true);
  check('placement defaults to overlay', defaults().captionPlacement, 'overlay');
  check('position is remembered by default', defaults().rememberPosition, true);
  check('speed defaults to 1x', defaults().defaultSpeed, '1');

  // A stored value from a future or broken state coerces rather than throwing.
  const placement = SETTINGS.find((s) => s.id === 'captionPlacement');
  check('an unknown placement falls back to overlay', placement.coerce('sideways'), 'overlay');
  check('a known placement survives', placement.coerce('below'), 'below');

  const speed = SETTINGS.find((s) => s.id === 'defaultSpeed');
  // A number, not a string, is the realistic wrong input, a control that stored
  // `1.25` rather than `"1.25"` should not lose the choice.
  check('a numeric speed is accepted and normalised', speed.coerce(1.25), '1.25');
  check('an off-list speed falls back to 1x', speed.coerce('3'), '1');

  // Toggles coerce truthily, so a stored 0 or "" does not become a live `true`.
  const captions = SETTINGS.find((s) => s.id === 'captionsOn');
  check('a falsy stored toggle is false', captions.coerce(0), false);
  check('a truthy stored toggle is true', captions.coerce(1), true);

  const size = SETTINGS.find((s) => s.id === 'captionSize');
  check('caption size clamps to its range', size.coerce(999), 34);
  check('and to the bottom of it', size.coerce(-5), 12);
  check('and rejects nonsense', size.coerce('big'), 20);

  // The four SHARED preferences must be readable by the viewer, not only by the
  // panel, the viewer draws the same transcript, so a `panel`-only audience would
  // have left its captions grading against a list nobody chose.
  for (const id of ['listId', 'threshold', 'studyLanguage', 'glossLanguage']) {
    const setting = SETTINGS.find((s) => s.id === id);
    check(`"${id}" reaches the viewer`, setting.audience.includes('viewer'), true);
    check(`and the panel still has it`, setting.audience.includes('panel'), true);
  }

  // And there is no SECOND copy of those preferences under a viewer-specific name.
  // That was the first attempt and it is the split this replaced.
  for (const gone of ['readerListId', 'readerThreshold']) {
    check(`"${gone}" no longer exists`, SETTINGS.some((s) => s.id === gone), false);
  }

  // The viewer's caption settings are SEPARATE from the panel's text size. One
  // control for both would mean changing the transcript size also changed the
  // subtitles on the video, which is not what either is for.
  check(
    'caption size is a different setting from the panel text size',
    SETTINGS.find((s) => s.id === 'captionSize') === SETTINGS.find((s) => s.id === 'fontSize'),
    false,
  );
}

section('the settings view and the transcript bar are two doors to one list');

{
  // The view renders EVERY panel-side setting, not only the ones without a bar
  // control. The first attempt filtered `quick` out and produced a view with two
  // rows in it, because the language and translation controls all live in the bar,
  // a settings view that omits what you most often change is not a settings view.
  const view = forSettingsView().map((s) => s.id);
  // `map` is excluded on purpose: it is internal memory (the threshold remembered
  // per list), not something a person edits, rendering it would offer a raw object
  // as a control. So the expected set is the panel-side settings minus the maps.
  const panel = byAudience('panel')
    .filter((s) => s.type !== 'map')
    .map((s) => s.id);
  check('the view shows every renderable panel-side setting', view.sort(), panel.sort());

  // And there is a map in the registry at all, so that exclusion is not theoretical.
  check(
    'there is at least one map setting for that filter to matter',
    SETTINGS.some((s) => s.type === 'map'),
    true,
  );

  // `quick` means "also has a control in the bar", a shortcut, not an exclusive
  // home. So the bar's set must be a SUBSET of the view's, never disjoint from it.
  const bar = forTranscriptBar().map((s) => s.id);
  const strays = bar.filter((id) => !view.includes(id));
  check('nothing in the bar is missing from the view', strays, []);
  check('and the bar really is a subset', bar.length > 0 && bar.length < view.length, true);

  // The two parked settings are now live, which is what the view existing changed.
  // Asserted because "hidden until there is a surface" was the recorded reason, and
  // leaving the flag on would silently keep them invisible.
  for (const id of ['toneStyle', 'markStyle']) {
    check(`"${id}" is no longer hidden`, SETTINGS.find((s) => s.id === id).hidden, undefined);
  }
  // And the one that stays hidden stays hidden, deliberately.
  check(
    '"scriptConversion" is still hidden, on purpose',
    SETTINGS.find((s) => s.id === 'scriptConversion').hidden,
    true,
  );

  // Nothing hidden may reach either surface.
  check('no hidden setting is in the view', view.filter((id) => SETTINGS.find((s) => s.id === id).hidden), []);
  check('no hidden setting is in the bar', bar.filter((id) => SETTINGS.find((s) => s.id === id).hidden), []);
}

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
