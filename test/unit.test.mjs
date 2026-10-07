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
import { defaults, SETTINGS } from '../src/common/settings.js';

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
// blinked off, and the Live view — which shows only the active row — went
// completely blank between every pair of lines.
check('in a gap after a cue, the finished line still holds', findActiveIndex(timeline, 5), 0);
check('inside the last cue', findActiveIndex(timeline, 21), 2);
check('past the end holds the last cue', findActiveIndex(timeline, 999), 2);
check('empty transcript', findActiveIndex([], 5), -1);
check('a single cue', findActiveIndex([seg(0, 'only', 1)], 0.5), 0);

// --- alignSecondary: the safety property -------------------------------------

section('alignSecondary — the safe cases');

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

section('alignSecondary — the safety property');

// Each of these must produce blanks. A wrong pairing here is the failure mode
// that matters: the panel would show a confident, incorrect translation.
check('a cue far in the future is not adopted', alignSecondary([seg(10, 'a')], [seg(16, 'A')]), ['']);
check('a cue far in the past is not adopted', alignSecondary([seg(10, 'a')], [seg(2, 'A')]), ['']);
check(
  'a whole track offset by a minute lines up with nothing',
  alignSecondary([seg(0, 'a'), seg(10, 'b')], [seg(60, 'A'), seg(70, 'B')]),
  ['', ''],
);

section('alignSecondary — tolerance boundary');

// The threshold is 1500ms. Pinning both sides of it means a change to the
// constant is a deliberate act rather than an accident.
const atLimit = alignSecondary([seg(10, 'a')], [seg(11.5, 'A')]);
const pastLimit = alignSecondary([seg(10, 'a')], [seg(11.6, 'A')]);
check('exactly at the limit pairs', atLimit, ['A']);
check('just past the limit does not', pastLimit, ['' ]);
check('the limit is configurable', alignSecondary([seg(10, 'a')], [seg(16, 'A')], 10_000), ['A']);

section('alignSecondary — no cue is used twice');

// A single secondary cue should not be copied onto several primary rows just
// because it happens to be the nearest for each of them.
const reused = alignSecondary([seg(0, 'a'), seg(1, 'b'), seg(2, 'c')], [seg(0, 'ONLY')]);
check('one secondary cue fills at most one row', reused.filter((s) => s !== '').length, 1);

section('alignSecondary — shape guarantees');

const longPrimary = [seg(0, 'a'), seg(1, 'b'), seg(2, 'c'), seg(3, 'd')];
check('output length always matches the primary', alignSecondary(longPrimary, [seg(0, 'A')]).length, longPrimary.length);
check('output is always strings', alignSecondary(longPrimary, []).every((s) => typeof s === 'string'), true);

section('settings defaults are copied, not shared');

{
  // A default that is an object is a single object living in the settings
  // module, so handing it out unchanged gives every caller — and every service
  // worker booted in one test process — the SAME reference. Writing to it then
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

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
