/**
 * Runs every hermetic test file in this folder and aggregates the result.
 *
 * "Hermetic" is the point: these never touch the network and never launch a
 * browser, so they are fast enough to run on every change. Anything that opens
 * a real browser or reaches the network lives in test/browser/ and is opt-in,
 * see TESTING.md for why that split exists and how to run each tier.
 *
 * Each file is spawned as its own process on purpose. They all reach for the
 * same globals, `chrome`, `document`, and the module cache, and a shared
 * process would let one suite's stubs leak into another's. Isolation is cheaper
 * than defending against that.
 *
 * No test framework: these are plain scripts that print and exit non-zero on
 * failure, so `npm test` works with nothing installed.
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Files that are shared scaffolding, not suites. */
const NOT_A_SUITE = new Set(['run.mjs', 'chrome-stub.mjs', 'dom-stub.mjs']);

// Top level only: test/browser/ holds the opt-in suites, which are deliberately
// excluded from this count and run by test/browser/run-browser.mjs instead.
const files = (await readdir(here, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs') && !NOT_A_SUITE.has(entry.name))
  .map((entry) => entry.name)
  .sort();

if (files.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

/**
 * @param {string} file
 * @returns {Promise<{file: string, code: number, output: string}>}
 */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { cwd: join(here, '..') });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ file, code: code ?? 1, output }));
  });
}

/**
 * Run every suite at once and report as they finish.
 *
 * These were run one at a time. Because each file is already its own process,
 * that bought nothing: the suites are independent, the machine has cores to
 * spare, and the slowest one is slow for a reason that needs fixing separately
 * (it sleeps on real timers waiting for the dictionary) rather than by serialising
 * everyone behind it. Running them together makes the wall time the slowest
 * suite rather than the sum.
 *
 * The output is deliberately ordered by the declaration above rather than by
 * completion, so a run looks the same every time, a report that reorders itself
 * between runs is hard to diff against the last one.
 *
 * @param {string[]} names
 * @returns {Promise<Array<{file: string, code: number, output: string}>>}
 */
function runAll(names) {
  return Promise.all(names.map(run));
}

const results = await runAll(files);

for (const result of results) {
  const passed = /(\d+)\/(\d+) checks passed/.exec(result.output);
  const label = result.code === 0 ? 'ok  ' : 'FAIL';
  const summary = passed ? `${passed[1]}/${passed[2]}` : '-';
  console.log(`${label}  ${result.file.padEnd(28)} ${summary}`);

  // Only print detail for failures; a green run should be quiet.
  if (result.code !== 0) console.log(result.output);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} suites passed`);

if (failed.length) {
  console.log(`\nFailing: ${failed.map((r) => r.file).join(', ')}`);
}

process.exit(failed.length === 0 ? 0 : 1);
