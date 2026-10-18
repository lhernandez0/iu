/**
 * Runs the browser test tier.
 *
 *   node test/browser/run-browser.mjs
 *
 * There is no live tier. It used to exist and was gated behind a flag, but it was
 * still a second thing that opened youtube.com, and the rule is that exactly one
 * command ever does that: `npm run capture`. A capture is taken once per video
 * and the resulting fixtures are replayed here, so this tier is offline, always,
 * and cannot reach the network even by accident.
 *
 * Each suite gets its own browser in its own process, for the same reason the
 * hermetic suites do: they share globals, and a leaked stub is worse than a slow
 * run.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const suites = ['iu.browser.test.mjs', 'viewer.test.mjs', 'ui-preview.test.mjs', 'ui-hmr.test.mjs', 'ui-layout.test.mjs', 'firefox.test.mjs'];

console.log('Browser tests: offline, against captured fixtures\n');

/**
 * @param {string} file
 * @returns {Promise<{file: string, code: number, output: string, skipped: boolean}>}
 */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { cwd: join(here, '../..') });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ file, code: code ?? 1, output, reasons: skipReasons(output) }));
  });
}

/**
 * The reason a suite gave for skipping, one per line.
 *
 * Matched on a LINE that starts with `SKIP`, not on the substring appearing
 * anywhere. The substring test was wrong in the way that matters: it counted a
 * suite as skipped for mentioning the word, and it let the summary here invent a
 * reason. The runner used to print "no browser able to load extensions was found"
 * for EVERY skip, which was untrue the moment a suite had a different reason: the
 * Firefox suite skips because Firefox will not load an unsigned extension, and the
 * message said the opposite of what the suite had just printed underneath it.
 *
 * @param {string} output
 * @returns {string[]}
 */
function skipReasons(output) {
  return output
    .split('\n')
    .map((line) => /^\s*SKIP\s+(.*)$/.exec(line)?.[1]?.trim())
    .filter(Boolean);
}

const results = [];
for (const file of suites) {
  console.log(`${'─'.repeat(70)}\n${file}\n${'─'.repeat(70)}`);
  const result = await run(file);
  results.push(result);
  console.log(result.output.trimEnd());
}

console.log(`\n${'─'.repeat(70)}`);
const skipped = results.filter((r) => r.reasons.length > 0);
// A non-zero exit is a failure, FULL STOP, even if the suite also skipped something.
// Excluding skipped suites from this was wrong: a suite that skips one section and
// then fails another exits non-zero, and treating it as "skipped, therefore fine"
// would hide the failure behind the word SKIP. Every skip path in THIS tier exits 0
// deliberately, so a non-zero code can only mean a real failure.
const failed = results.filter((r) => r.code !== 0);

for (const result of results) {
  const summary = /(\d+)\/(\d+) checks passed/.exec(result.output);
  const ran = Number(summary?.[1] ?? 0);
  // A non-zero exit outranks a skip: a suite that skipped one section and then
  // failed another must read FAIL, or the word SKIP becomes a place to hide a
  // failure. Below that, a suite that skipped SOME of itself and still ran checks is
  // neither `ok` nor `SKIP`: `SKIP` would bury a green count, `ok` would bury the
  // skip. The Firefox suite runs nothing; the browser suite skips a section of many.
  const label =
    result.code !== 0 ? 'FAIL' : result.reasons.length === 0 ? 'ok  ' : ran > 0 ? 'part' : 'SKIP';
  console.log(`${label}  ${result.file.padEnd(34)} ${summary ? `${summary[1]}/${summary[2]}` : '-'}`);
}

// Each suite's OWN reason, not one invented here. A suite that skips has to say why
// and this repeats what it said, so the summary and the body cannot disagree.
if (skipped.length) {
  console.log('\nSkipped, and why (each suite\'s own reason):');
  for (const result of skipped) {
    for (const reason of result.reasons) console.log(`  ${result.file}: ${reason}`);
  }
}
if (failed.length) console.log(`\nFailing: ${failed.map((r) => r.file).join(', ')}`);

process.exit(failed.length === 0 ? 0 : 1);
