/**
 * The media decoder works.
 *
 * ## What this proves, and what it replaces
 *
 * An earlier version of this work asserted that the committed decoder rebuilt
 * byte-for-byte in CI. That proves the artifact was PRODUCED by its inputs. It
 * does not prove the artifact WORKS, and the failure that matters to a user is a
 * decoder that returns silence, which a hash comparison cannot see.
 *
 * So this decodes a real E-AC-3 fixture with the built decoder and checks the
 * samples. It is hermetic: libav.js has a Node branch, so no browser is needed,
 * and the fixture is committed.
 *
 * ## Why it skips, and why that is correct
 *
 * `build/libav/` is a build product, not committed (ADR 0011). Without it there
 * is nothing to test, and the honest answer is to say so and move on, which is
 * what `test/mkv` (needs `ffmpeg`) and `test/conformance` (needs a fetch) already
 * do. The default loop stays fast and toolchain-free; CI builds the decoder
 * before running this.
 *
 * The check that the artifact EXISTS when it should is in `make stage`, which
 * fails a release rather than shipping an extension with no decoder.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DECODER = join(ROOT, 'src', 'vendor', 'libav.js');
const FIXTURE = join(ROOT, 'test', 'mkv', 'one-eac3.mkv');
const EXPECTED = join(ROOT, 'tools', 'libav', 'expected.json');

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

console.log('\nthe built media decoder decodes Dolby audio');

if (!existsSync(DECODER)) {
  // Not a failure. See the header: this is the same shape as any other
  // toolchain-gated tier in this project.
  console.log('  skip  src/vendor/libav.js is not built');
  console.log('        run `npm run vendor:libav` to build it (needs emcc)');
  process.exit(0);
}

// The expected values live beside the variant definition rather than in this
// file, so the fixture and its numbers are reviewed together.
const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));

const LibAV = (await import(DECODER)).default;
// No `noworker` flag: under Node there is no Worker, and the browser path is
// exercised by the browser tier. What is under test here is the COMPILED CODEC.
const libav = await LibAV.LibAV({ noworker: true });

const bytes = new Uint8Array(readFileSync(FIXTURE));
await libav.writeFile('in.mkv', bytes);

const [format, streams] = await libav.ff_init_demuxer_file('in.mkv');
const audio = streams.find((stream) => stream.codec_type === 1);

check('the fixture demuxes to an audio stream', Boolean(audio), true);
check('the audio codec id is the one expected', audio?.codec_id, expected.codecId);

const [, decoder, packets, frame] = await libav.ff_init_decoder(audio.codec_id, audio.codecpar);
// `ff_read_frame_multi`, not the older `ff_read_multi`: the latter logs a
// deprecation notice on every run, and a test that is noisy on success is a test
// people stop reading.
const [, read] = await libav.ff_read_frame_multi(format, packets);
const frames = await libav.ff_decode_multi(decoder, packets, frame, read[audio.index], true);

check('it decodes the expected number of frames', frames.length, expected.frames);

// Count every sample and track the peak. A decoder that returns correctly sized
// silence would pass a frame count and fail this, which is exactly the bug worth
// catching: it is the same failure a learner sees, a file that plays no sound.
let total = 0;
let nonzero = 0;
let peak = 0;
for (const decoded of frames) {
  for (const plane of decoded.data) {
    for (let i = 0; i < plane.length; i++) {
      const value = Math.abs(plane[i]);
      if (value > peak) peak = value;
      if (value > 0) nonzero++;
      total++;
    }
  }
}

check('the decoded sample count matches', total, expected.samples);
check('every decoded sample is nonzero', nonzero, expected.samples);
check('the sample rate is the expected one', frames[0]?.sample_rate, expected.sampleRate);
check('the peak is a real signal, not a rounding artefact', peak > 0.001, true);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
