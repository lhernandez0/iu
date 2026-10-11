/**
 * Rebuild the dictionaries from their pinned sources and fail on any difference.
 *
 *   node tools/check-wordlists.mjs
 *
 * ## Why this exists
 *
 * `src/learn/data/*.json` is committed, and nothing verified it could still be
 * produced from the revisions it names. Every existing check reads the file: the
 * licence test confirms it declares a source, the learn tests confirm its shape.
 * None of them can see a file that is well-formed, correctly shaped, and WRONG.
 *
 * That is not hypothetical. `japanese.json` shipped with two glosses that no
 * JMdict release has ever contained (`投書` as "letter from a viewer" and `例題` as
 * "exercise (for the viewer)"), because a copy-edit renaming the UI's "reader" to
 * "viewer" swept across the committed data file. Every test passed. The drift was
 * found by hand, months later, while proving something else. This script is what
 * would have caught it the day it happened.
 *
 * ## What it does
 *
 * Fetches the pinned inputs if they are not already cached, rebuilds each
 * dictionary into a temporary directory, and compares bytes with what is
 * committed. Any difference is a FAILURE, not a warning: a committed dictionary
 * that cannot be reproduced is one nobody reviewed.
 *
 * Run `npm run wordlists:fetch` first, or let this do it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const CACHE = join(ROOT, '.cache/wordlists');
const DATA = join(ROOT, 'src/learn/data');
const BUILT = join(ROOT, '.cache/rebuilt');

/** The files the build owns, so a stale one in the tree cannot be mistaken for real. */
const GENERATED = ['chinese.json', 'japanese.json', 'korean.json', 'index.json'];

async function main() {
  // The fetch is idempotent and cached, so calling it here means a fresh clone
  // needs one command rather than two, and a CI job cannot forget the step.
  await run(process.execPath, [join(here, 'fetch-wordlists.mjs')], { cwd: ROOT });

  await mkdir(BUILT, { recursive: true });

  // Build into a scratch directory, never over the committed files. A script that
  // verified the data by OVERWRITING it would destroy the evidence when it failed,
  // and the failure it is looking for is precisely "the committed file is wrong".
  const scratch = await mkdtemp();

  await run(
    process.execPath,
    [
      join(here, 'build-wordlist.mjs'),
      '--zh', join(CACHE, 'parsed_hsk_enriched.json'),
      '--ja', join(CACHE, 'jmdict-eng-common-3.6.2.json'),
      '--jlpt', CACHE,
      '--ko', join(CACHE, 'results.tsv'),
      '--ko-yonsei', CACHE,
      '--out', scratch,
    ],
    { cwd: ROOT },
  );

  let failures = 0;
  for (const file of GENERATED) {
    const builtPath = join(scratch, file);
    const committedPath = join(DATA, file);

    if (!existsSync(builtPath)) {
      console.error(`  FAIL  ${file}: the build did not produce it`);
      failures++;
      continue;
    }

    const built = await readFile(builtPath);
    const committed = await readFile(committedPath);

    if (built.equals(committed)) {
      console.log(`  ok    ${file} reproduces exactly`);
      continue;
    }

    // Say WHERE they differ. On a one-line JSON file a byte offset is useless on
    // its own, so the message carries the surrounding text from both sides, which
    // is enough to see whether it is a value, an ordering, or a field.
    const a = committed.toString('utf8');
    const b = built.toString('utf8');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.error(`  FAIL  ${file}: differs at byte ${i}`);
    console.error(`        committed: ...${JSON.stringify(a.slice(Math.max(0, i - 40), i + 80))}`);
    console.error(`        rebuilt  : ...${JSON.stringify(b.slice(Math.max(0, i - 40), i + 80))}`);
    failures++;
  }

  await rm(scratch, { recursive: true, force: true });

  if (failures) {
    console.error(
      `\n${failures} file(s) do not reproduce. Either the data was edited by hand, or a\n` +
      'source revision moved. Rebuild with `npm run wordlists:build` and review the\n' +
      'diff before committing: a hand-edit here means the licence provenance is a lie.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('\nevery dictionary reproduces from its pinned sources');
}

/**
 * A scratch directory under `.cache`, so it is inside the repo the build expects
 * and is ignored by git rather than landing in `/tmp` where a CI job cannot see it.
 *
 * @returns {Promise<string>}
 */
async function mkdtemp() {
  const path = join(BUILT, `run-${process.pid}`);
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  return path;
}

await main();
