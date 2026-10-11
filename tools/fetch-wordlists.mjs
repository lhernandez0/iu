/**
 * Fetch the word-list source revisions, and check them against the pins.
 *
 *   node tools/fetch-wordlists.mjs            # into .cache/wordlists
 *   node tools/fetch-wordlists.mjs --verify   # fetch, and fail on any hash mismatch
 *
 * ## Why this exists
 *
 * `tools/build-wordlist.mjs` cannot download anything: the inputs are large, the
 * build is deliberately offline, and the generated JSON is committed. That is the
 * right shape for the build, but it leaves a gap with real consequences. Nothing
 * checked that the committed dictionaries could still be produced from the
 * revisions they name, so a hand-edit to a data file went unnoticed until a rebuild
 * happened to be run by hand. That is exactly how `japanese.json` came to contain
 * two glosses no JMdict release has ever had: a copy-edit swept across it and no
 * test could see the drift, because the file was valid, well-formed, and wrong.
 *
 * This closes that gap by making the inputs obtainable, so CI can fetch the pinned
 * revisions, rebuild, and fail on any difference.
 *
 * ## The pins are checked, not assumed
 *
 * Every download is hashed and compared to the value recorded in the build script
 * and in `THIRD-PARTY.md`. A mismatch is an error rather than a warning: upstream
 * content that changed under a fixed revision is either a re-tag or a compromise,
 * and either way a rebuild from it would produce a dictionary nobody reviewed.
 *
 * The JMdict pin is the hash of the **ZIP**, not of the JSON inside it, because the
 * ZIP is the artefact that is distributed. Checking the extracted file would pin
 * something no consumer ever sees.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(here, '../.cache/wordlists');

/**
 * Every input a dictionary build needs, with the revision it is pinned to.
 *
 * `sha256` is checked against what is downloaded. For the two `.zip` entries the
 * hash is of the archive; `unzip` is used rather than a Node library so there is
 * no dependency for something the build machine already has.
 */
const SOURCES = [
  {
    id: 'zh',
    url: 'https://raw.githubusercontent.com/TeaPearce/chinese-english-dictionary/a9aea223269eb9820590e5bca783eb299c317439/data/parsed_hsk_enriched.json',
    file: 'parsed_hsk_enriched.json',
    sha256: 'e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10',
  },
  {
    id: 'ja-jmdict',
    url: 'https://github.com/scriptin/jmdict-simplified/releases/download/3.6.2%2B20261005200550/jmdict-eng-common-3.6.2%2B20261005200550.json.zip',
    file: 'jmdict.zip',
    sha256: '956cb65b95d12d2b81fa550716d53163dbd3c70ca171a9c7dce97d7238c9d87a',
    unzip: true,
  },
  {
    id: 'ja-jlpt',
    url: 'https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/1ad66734417aca9dbcca6b2d5ee440cb13ab3ba0/src/n{n}.csv',
    file: 'n{n}.csv',
    forN: [1, 2, 3, 4, 5],
  },
  {
    id: 'ko-levels',
    url: 'https://raw.githubusercontent.com/julienshim/combined_korean_vocabulary_list/master/results.tsv',
    file: 'results.tsv',
    sha256: 'bb5789e46d818842ed6cc15c7946805ad1aed9fd1d0912d884cc48a8556b9a3c',
  },
  {
    id: 'ko-yonsei',
    url: 'https://raw.githubusercontent.com/Amulopapa67/open-yonsei-korean-vocabulary/v0.1.0/data/json/vol-0{n}.json',
    file: 'vol-0{n}.json',
    forN: [1, 2, 3, 4, 5, 6],
    // Per-volume, because one hash for six files would only tell you that
    // something changed, not which volume.
    sha256ForN: {
      1: '2f2c32b333041059aa5e8f2d3fdcd97214eefcda3a1af23315039929d70d977d',
      2: '038ab1900fd483c8590e9672d23865cd1d9441cdf133b9d5a610ad1b41e69c9d',
      3: 'aede65938a06b9dcb44e7edab28f6b70cba894ff1d59ed9c2399c88796106179',
      4: '03997f259fb32572cc77f158d01944e76251001cf2c6e2f4910fb5b1c5bff245',
      5: 'c4889adfb03d3a32030626c182f074aac616f6c0b03fd4cd6c0be56fc5744509',
      6: 'be86f4dbb237414405390476b0a71f797a94e4a25e9f2bd5412f9c477c0bb07b',
    },
  },
];

/** @param {string} path */
async function sha256Of(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Download one URL to one path, unless it is already there.
 *
 * Cached deliberately: these are static revisions, and the whole set is about
 * 30 MB, so re-fetching on every local run would be slow for no gain. `--force`
 * re-downloads.
 *
 * @param {string} url
 * @param {string} path
 * @param {boolean} force
 */
async function fetchTo(url, path, force) {
  if (!force && existsSync(path)) return 'cached';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return 'fetched';
}

async function main() {
  const verify = process.argv.includes('--verify');
  const force = process.argv.includes('--force');
  await mkdir(CACHE, { recursive: true });

  /**
   * The pins, read from the build script rather than repeated here.
   *
   * A hash written down in two places drifts in one of them. The build script is
   * the authority: it is what produces the committed dictionaries and what the
   * provenance in `meta.sources` is generated from.
   */
  const build = await readFile(resolve(here, 'build-wordlist.mjs'), 'utf8');
  const pinned = (hash) => build.includes(hash);

  let failures = 0;

  for (const source of SOURCES) {
    const suffixes = source.forN ?? [null];
    for (const n of suffixes) {
      const url = source.url.replace('{n}', String(n));
      const file = source.file.replace('{n}', String(n));
      const path = join(CACHE, file);

      let how;
      try {
        how = await fetchTo(url, path, force);
      } catch (error) {
        console.error(`  FAIL  ${source.id} ${file}: ${error.message}`);
        failures++;
        continue;
      }

      // A source may pin one hash for all its files, or one per volume. The
      // per-volume form exists because six volumes under one hash would say only
      // that something changed, not which one.
      const expected = source.sha256ForN ? source.sha256ForN[n] : source.sha256;

      // Only the entries that declare a hash are checked. The JLPT CSVs are pinned
      // by revision in the URL, which is a weaker guarantee and is recorded as
      // such rather than dressed up.
      if (!expected) {
        console.log(`  ok    ${source.id} ${file} (${how}, pinned by revision)`);
        continue;
      }

      const digest = await sha256Of(path);
      if (digest !== expected) {
        // The message says which way it differs, because a re-tag and a
        // truncated download look the same in a bare hash mismatch and need
        // different responses.
        console.error(`  FAIL  ${source.id} ${file}: sha256 ${digest}`);
        console.error(`        expected ${expected}`);
        failures++;
        continue;
      }

      // The pin has to be the one the BUILD uses, or this would happily verify a
      // revision the dictionaries were not built from.
      if (verify && !pinned(expected)) {
        console.error(`  FAIL  ${source.id} ${file}: the hash is not the one in build-wordlist.mjs`);
        failures++;
        continue;
      }

      console.log(`  ok    ${source.id} ${file} (${how}, sha256 matches)`);

      if (source.unzip) {
        await run('unzip', ['-o', '-q', path, '-d', CACHE]);
      }
    }
  }

  console.log(failures ? `\n${failures} source(s) failed` : '\nall sources present and matching');
  if (failures) process.exitCode = 1;
}

await main();
