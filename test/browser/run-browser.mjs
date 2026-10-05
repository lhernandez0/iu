/**
 * Runs the browser test tiers.
 *
 *   node test/browser/run-browser.mjs          # offline only
 *   node test/browser/run-browser.mjs --live   # offline, then live (real network)
 *
 * The live tier refuses to run without the flag rather than merely defaulting
 * off, so there is no command that reaches the network by accident. Each suite
 * gets its own browser in its own process, for the same reason the hermetic
 * suites do: they share globals, and a leaked stub is worse than a slow run.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes('--live');

const suites = ['iu.browser.test.mjs'];
if (live) suites.push('iu.live.test.mjs');

console.log(live ? 'Browser tests: offline, then LIVE (real network)\n' : 'Browser tests: offline only\n');

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
  console.log(`${label}  ${result.file.padEnd(34)} ${summary ? `${summary[1]}/${summary[2]}` : '—'}`);
}

if (skipped.length) console.log('\nSkipped: no browser able to load extensions was found.');
if (failed.length) console.log(`\nFailing: ${failed.map((r) => r.file).join(', ')}`);

process.exit(failed.length === 0 ? 0 : 1);
