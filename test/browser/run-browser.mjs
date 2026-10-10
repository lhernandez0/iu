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

const suites = ['iu.browser.test.mjs', 'viewer.test.mjs', 'ui-preview.test.mjs', 'ui-hmr.test.mjs', 'ui-layout.test.mjs'];

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
    child.on('close', (code) => resolve({ file, code: code ?? 1, output, skipped: output.includes('SKIP') }));
  });
}

const results = [];
for (const file of suites) {
  console.log(`${'─'.repeat(70)}\n${file}\n${'─'.repeat(70)}`);
  const result = await run(file);
  results.push(result);
  console.log(result.output.trimEnd());
}

console.log(`\n${'─'.repeat(70)}`);
const skipped = results.filter((r) => r.skipped);
const failed = results.filter((r) => r.code !== 0 && !r.skipped);

for (const result of results) {
  const summary = /(\d+)\/(\d+) checks passed/.exec(result.output);
  const label = result.skipped ? 'SKIP' : result.code === 0 ? 'ok  ' : 'FAIL';
  console.log(`${label}  ${result.file.padEnd(34)} ${summary ? `${summary[1]}/${summary[2]}` : '-'}`);
}

if (skipped.length) console.log('\nSkipped: no browser able to load extensions was found.');
if (failed.length) console.log(`\nFailing: ${failed.map((r) => r.file).join(', ')}`);

process.exit(failed.length === 0 ? 0 : 1);
