#!/usr/bin/env node
/**
 * Fetch the Matroska conformance suite.
 *
 * **This is a development dependency, not part of the shipped extension.** Nothing
 * in `src/` reads these files and none of them are in the store package. They exist
 * so a contributor can check the container parser against files written by the
 * people who maintain Matroska itself.
 *
 * ## What the suite is
 *
 * `ietf-wg-cellar/matroska-test-files` is the IETF CELLAR working group's
 * conformance suite, eight files, each probing one feature, authored by the
 * mkvmerge and libmatroska maintainers. In their words: *\"The files presented here
 * represent the minimum support a player should have.\"*
 *
 * ## Why it is worth the megabytes
 *
 * Our own generated fixtures all come from one muxer with default settings, and
 * that turned out to be a real blind spot: `test2.mkv` sets `TimecodeScale` to a
 * non-default value, which exposed a bug where **every timestamp was ten times too
 * large** and nothing in the repo could see it. A conformance suite exists to catch
 * exactly the class of mistake a single generator cannot.
 *
 * ## What it does NOT cover
 *
 * Cellar's suite is about CONTAINERS, not about our features. It has no
 * `S_TEXT/ASS` track, no image-subtitle file, and no file without subtitles, those
 * cases stay with our own fixtures, which are shaped for them.
 *
 * ## Licensing, and what it obliges
 *
 * The files contain Big Buck Bunny and Elephants Dream, both **CC-BY**, so
 * attribution is required and is recorded in `THIRD-PARTY.md`. They are downloaded
 * rather than committed: they are real films, tens to hundreds of megabytes.
 *
 * Usage:  npm run conformance:fetch
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'conformance');

/**
 * The files, with what each one is for.
 *
 * Recorded here rather than only in the suite's own README, because the reason we
 * want a file is the useful part when a test using it fails. `tests` says whether
 * our parser should already handle it, a file we knowingly cannot read is listed
 * so the limitation is visible rather than absent.
 */
const FILES = [
  { name: 'test1.mkv', what: 'the minimum a compliant player handles: SimpleBlocks only', tests: true },
  { name: 'test2.mkv', what: 'non-default TimecodeScale (100,000 ns) and CRC-32 elements', tests: true },
  { name: 'test3.mkv', what: 'header stripping and BlockGroup', tests: true },
  { name: 'test4.mkv', what: 'unknown-size clusters, as a live recording is written', tests: false },
  { name: 'test5.mkv', what: 'seven subtitle languages in one file', tests: true },
  { name: 'test6.mkv', what: 'element sizes coded in 1 or 8 bytes, and no Cues', tests: true },
  { name: 'test7.mkv', what: 'unknown junk elements and a deliberately damaged region', tests: true },
  { name: 'test8.mkv', what: 'an audio gap, not our concern, kept for completeness', tests: false },
];

const BASE = 'https://raw.githubusercontent.com/ietf-wg-cellar/matroska-test-files/master/test_files';

mkdirSync(OUT, { recursive: true });

let fetched = 0;

for (const file of FILES) {
  const target = join(OUT, file.name);

  if (existsSync(target)) {
    const mb = statSync(target).size / 1e6;
    console.log(`  have  ${file.name}  (${mb.toFixed(1)} MB), ${file.what}`);
    continue;
  }

  process.stdout.write(`  get   ${file.name} … `);
  try {
    const response = await fetch(`${BASE}/${file.name}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // Streamed to disk rather than buffered: these are real films, and one of them
    // is large enough that holding it in memory to write it out is pointless.
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));

    const mb = statSync(target).size / 1e6;
    console.log(`${mb.toFixed(1)} MB, ${file.what}`);
    fetched++;
  } catch (error) {
    // A partial download is worse than none: it would be read as a corrupt file
    // and reported as a parser failure. Removed rather than left behind.
    rmSync(target, { force: true });
    console.error(`FAILED (${String(error?.message ?? error)})`);
    console.error('\nCould not download the conformance suite. Check your connection, then');
    console.error('re-run `npm run conformance:fetch`. Nothing else needs these files.');
    process.exit(1);
  }
}

console.log(`\n${FILES.length} files in test/conformance/${fetched ? ` (${fetched} fetched)` : ' (all present)'}`);
console.log('\nRun the conformance tests with:  npm run test:conformance');
console.log('These files are CC-BY (Blender Foundation) and are NOT part of the packaged extension.');
