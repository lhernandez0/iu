/**
 * Runs every test file in this folder and aggregates the result.
 *
 * Each file is spawned as its own process on purpose. They all reach for the
 * same globals — `chrome`, `document`, and the module cache — and a shared
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

const files = (await readdir(here)).filter((name) => name.endsWith('.test.mjs') && !NOT_A_SUITE.has(name)).sort();

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

const results = [];
for (const file of files) {
  const result = await run(file);
  results.push(result);

  const passed = /(\d+)\/(\d+) checks passed/.exec(result.output);
  const label = result.code === 0 ? 'ok  ' : 'FAIL';
  const summary = passed ? `${passed[1]}/${passed[2]}` : '—';
  console.log(`${label}  ${file.padEnd(28)} ${summary}`);

  // Only print detail for failures; a green run should be quiet.
  if (result.code !== 0) console.log(result.output);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} suites passed`);

if (failed.length) {
  console.log(`\nFailing: ${failed.map((r) => r.file).join(', ')}`);
}

process.exit(failed.length === 0 ? 0 : 1);
