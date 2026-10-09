#!/usr/bin/env node
/**
 * The Matroska conformance suite, run against the container parser.
 *
 * **Not part of `npm test`.** It is a development dependency: the files are
 * hundreds of megabytes of CC-BY film, downloaded rather than committed, and a
 * contributor without them should still be able to run the main suite. So this
 * lives in a subdirectory the runner does not scan (`test/run.mjs` reads the top
 * level only) and is invoked deliberately:
 *
 *     npm run conformance:fetch    # once, downloads ~200 MB
 *     npm run test:conformance
 *
 * ## What it is for, given we already have generated fixtures
 *
 * Our own fixtures are all produced by one muxer with default settings, and that
 * was a genuine blind spot: every one of them uses the default `TimecodeScale`, so
 * a bug that made **every timestamp ten times too large** on files that do not was
 * invisible. A conformance suite is authored by the people who maintain Matroska
 * and its tools, and exists precisely to catch what a single generator cannot.
 *
 * ## How it treats limitations
 *
 * A file we cannot read is asserted as a KNOWN limitation with its reason, not
 * skipped and not failed. A silent skip reports green while proving nothing; a
 * blanket failure makes the suite useless as a signal. Naming it means the day the
 * parser improves, the assertion has to be updated — which is the point at which
 * someone notices.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMatroska, readMatroskaTracks } from '../../src/viewer/matroska.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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

/** @param {string} name */
function readerFor(name) {
  const bytes = readFileSync(join(HERE, name));
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}

// --- Availability ------------------------------------------------------------

const REQUIRED = ['test1.mkv', 'test2.mkv', 'test5.mkv', 'test6.mkv', 'test7.mkv'];
const missing = REQUIRED.filter((name) => !existsSync(join(HERE, name)));

if (missing.length) {
  console.log('\n  The conformance suite is not present.');
  console.log(`  Missing: ${missing.join(', ')}`);
  console.log('\n  It is a development dependency and is downloaded, not committed:');
  console.log('      npm run conformance:fetch');
  console.log('\n  Nothing else in the project needs these files.');
  process.exit(1);
}

const totalMb = REQUIRED.reduce((n, name) => n + statSync(join(HERE, name)).size / 1e6, 0);
console.log(`\nconformance suite: ${REQUIRED.length} files, ${totalMb.toFixed(0)} MB`);

// --- test2: the non-default TimecodeScale ------------------------------------

section('test2 — non-default TimecodeScale (the bug this suite found)');

{
  // The file sets `TimecodeScale` to 100,000 rather than the default 1,000,000.
  // A parser that assumes a millisecond reports every timestamp ten times too
  // large, with no error: a two-minute film's subtitles land at twenty minutes.
  //
  // Our own fixtures could not have caught this, because `ffmpeg` cannot write a
  // non-default scale — which is the whole argument for this suite existing.
  const file = readerFor('test2.mkv');
  const { timecodeScale, tracks } = await readMatroska({ ...file, trackNumbers: [] });

  check('the scale is READ, not assumed', timecodeScale, 100_000);
  check('and it is not the default', timecodeScale === 1_000_000, false);

  // Sanity on what the file contains, so a timestamp assertion below means
  // something. test2 carries H264 video and stereo AAC and no subtitles, so there
  // is nothing to extract — the scale is the only thing being proven here.
  check('the file has no subtitle tracks', tracks.length, 0);
}

// --- test1: the minimum a compliant player handles ---------------------------

section('test1 — the basic file, which must parse');

{
  const tracks = await readMatroskaTracks(readerFor('test1.mkv'));
  // SimpleBlocks only, MPEG4.2 video and MP3 audio, and no subtitle track. Parsing
  // this without error is the floor: if it throws, the walk is broken.
  check('a basic file parses and reports no subtitle tracks', tracks, []);
}

// --- test5: seven subtitle languages -----------------------------------------

section('test5 — a file with many subtitle languages');

{
  // **The suite's README says seven languages. The file has EIGHT subtitle
  // tracks**, which `ffprobe` confirms and this test now records. Two are English:
  // one labelled and one not, plus `und`. Discovering all of them matters because
  // the panel offers whatever `trackList` holds, and hiding one makes it
  // unselectable.
  //
  // The English part is the interesting one. Matroska defines an ABSENT `Language`
  // as English, and this file relies on that — its English track carries no
  // language element at all. Our parser previously collapsed "absent" with "und"
  // and reported null, which meant the English subtitles were offered and never
  // marked. `ffprobe` was the reference for what the file really contains.
  const file = readerFor('test5.mkv');
  const tracks = await readMatroskaTracks(file);

  check('all eight subtitle tracks are found', tracks.length, 8);
  check('and all of them are text', tracks.every((t) => t.kind === 'text'), true);

  const languages = tracks.map((t) => t.language);
  // English is present, via the format default rather than a tag — and flagged as
  // such, so a caller can tell an inference from a certainty.
  check('English is present, from the format default', languages.includes('en'), true);
  const inferred = tracks.filter((t) => t.languageDefaulted);
  check('exactly one track relied on that default', inferred.length, 1);
  check('and it is the first subtitle track', inferred[0]?.number, 3);

  // Normalised to what the word lists use, so a track is matchable at all.
  check('Japanese is normalised to ja', languages.includes('ja'), true);
  check('and no language came back as the raw 639-2 form', languages.includes('jpn'), false);

  // One track is genuinely `und` — the file SAYING it does not know. That stays
  // null, because it is knowledge rather than absence and must not be defaulted.
  check('und stays null rather than becoming English', languages.includes(null), true);

  // Cues, not just discovery. Many tracks in one file is where a per-track
  // selection bug shows up: extracting one must not consume another's blocks.
  const { cues } = await readMatroska({ ...file, trackNumbers: [tracks[0].number] });
  check('one track extracts on its own', (cues.get(tracks[0].number)?.length ?? 0) > 0, true);
  check('and no other track was extracted', cues.size, 1);

  // Every one of them, to prove the walk does not stop after the first.
  const all = await readMatroska({ ...file, trackNumbers: tracks.map((t) => t.number) });
  check('all eight extract together', all.cues.size, 8);
}

// --- test6: unusual element sizes --------------------------------------------

section('test6 — sizes coded in 1 or 8 bytes, and no Cues');

{
  // A parser of the EBML variable-length integer format. A reader that only
  // handled 1-byte sizes would work on our fixtures and fail here.
  const file = readerFor('test6.mkv');
  const tracks = await readMatroskaTracks(file);
  check('a file with 8-byte element sizes parses', Array.isArray(tracks), true);
  // Same shape as test1: no subtitle track, but the header walk must survive.
  check('and reports its tracks', tracks.length, 0);
}

// --- test7: junk and damage --------------------------------------------------

section('test7 — unknown elements and a damaged region');

{
  // Junk elements before and after clusters, and an invalid element partway
  // through. Real files are like this, and the parser's rule is that anything it
  // does not recognise is skipped BY SIZE — so this should parse rather than throw.
  const file = readerFor('test7.mkv');
  let threw = null;
  let tracks = null;
  try {
    tracks = await readMatroskaTracks(file);
  } catch (error) {
    threw = String(error?.message ?? error);
  }

  check('junk elements do not throw', threw, null);
  check('and the file is still read', Array.isArray(tracks), true);
}

// --- Known limitations, named so they cannot be forgotten --------------------

section('known limitations of this parser, asserted rather than hidden');

{
  // test4 uses unknown-size clusters, as a live recording is written. They ARE
  // handled now (see the unknown-size branch in `readMatroska`), but the file also
  // has no subtitle track, so the observable outcome is the same as test1.
  //
  // Asserted as a limitation rather than as a success, because "it did not throw"
  // is a weaker claim than "it read the cues" — and pretending the two are the same
  // is how a gap stops being visible.
  if (existsSync(join(HERE, 'test4.mkv'))) {
    const file = readerFor('test4.mkv');
    let tracks = null;
    try {
      tracks = await readMatroskaTracks(file);
    } catch (error) {
      tracks = String(error?.message ?? error);
    }
    check('test4 (unknown-size clusters) does not throw', Array.isArray(tracks), true);
    check('and has no subtitle tracks to read either way', tracks, []);
  } else {
    console.log('  skip  test4 (not downloaded)');
  }

  // Not a limitation of the parser but of the SUITE, recorded so nobody concludes
  // it covers more than it does: Cellar tests CONTAINERS, so it has no ASS track,
  // no image-subtitle file and no file without subtitles. Those cases stay with our
  // own fixtures, which are generated for them by `npm run fixtures`.
  check('the suite has no image-subtitle file of its own', existsSync(join(HERE, 'test-pgs.mkv')), false);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
