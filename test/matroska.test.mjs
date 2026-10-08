/**
 * Matroska subtitle extraction, against REAL files.
 *
 * The fixtures are not hand-written byte sequences — they are produced by
 * `ffmpeg`, so they are files a real muxer wrote, with real EBML framing, real
 * seek heads and real cluster structure. That distinction is the whole
 * justification for hand-rolling this parser: a parser that only meets fixtures
 * the author also wrote proves very little, and a muxer is more honest about the
 * format than either of us.
 *
 * `test/fixtures/` is gitignored, as the caption fixtures are and for the same
 * reason — they came from real tooling. `test/fixtures/README.md` records the
 * `ffmpeg` command that regenerates each one.
 *
 * Run: node test/matroska.test.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  readMatroska,
  readMatroskaTracks,
  readVint,
  imageCodecName,
  isTextCodec,
  normaliseLanguage,
} from '../src/reader/matroska.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test', 'fixtures');

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

/**
 * A `read(offset, length)` over a real file, mirroring what the reader page does
 * with a `File`.
 *
 * @param {string} name
 */
function readerFor(name) {
  const path = join(FIXTURES, name);
  const bytes = readFileSync(path);
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(offset + length, bytes.length)),
  };
}

/** Whether the fixture set is present. Skipped with a loud note if not. */
const HAVE_FIXTURES = existsSync(join(FIXTURES, 'three-tracks.mkv'));

section('EBML variable-length integers');

{
  // The encoding every id and size uses. The marker is the count of leading zero
  // bits in the first byte, and the value bits across all bytes are the number.
  const one = Uint8Array.from([0x81]);
  check('a 1-byte vint', readVint(one, 0, false)?.value, 1);
  check('and its width', readVint(one, 0, false)?.length, 1);

  const two = Uint8Array.from([0x40, 0x02]);
  check('a 2-byte vint', readVint(two, 0, false)?.value, 2);
  check('and its width', readVint(two, 0, false)?.length, 2);

  // Ids keep the marker, sizes drop it. Getting this the wrong way round makes
  // every id compare unequal to the constant it is checked against, and the
  // failure looks like "the file has no tracks".
  check('an id keeps its marker', readVint(Uint8Array.from([0xd7]), 0, true)?.value, 0xd7);

  // "All value bits set" is UNKNOWN SIZE — not a very large number. A real
  // Segment uses it, so reading it as a number skips the whole file.
  const unknown = Uint8Array.from([0xff]);
  check('all-ones is reported as unknown size', readVint(unknown, 0, false)?.unknown, true);

  check('a zero first byte is rejected', readVint(Uint8Array.from([0x00]), 0, false), null);
  check('a truncated vint is rejected', readVint(Uint8Array.from([0x40]), 0, false), null);
}

section('codec classification, so a picture of text is never mistaken for text');

{
  check('S_TEXT/UTF8 is text', isTextCodec('S_TEXT/UTF8'), true);
  check('S_TEXT/ASS is text', isTextCodec('S_TEXT/ASS'), true);
  check('S_TEXT/WEBVTT is text', isTextCodec('S_TEXT/WEBVTT'), true);

  // The important negatives. These hold images; there is no string in them, and
  // treating one as text would yield an empty transcript with no explanation.
  check('PGS is not text', isTextCodec('S_HDMV/PGS'), false);
  check('VobSub is not text', isTextCodec('S_VOBSUB'), false);
  check('and each is named for the user', [
    imageCodecName('S_HDMV/PGS'),
    imageCodecName('S_VOBSUB'),
    imageCodecName('S_DVBSUB'),
  ], ['Blu-ray PGS', 'DVD VobSub', 'DVB']);
  check('a text codec has no image name', imageCodecName('S_TEXT/UTF8'), null);
}

section('language codes are normalised to what the word lists use');

{
  // THE integration bug this exists for. A Matroska track says `zho` and `jpn`;
  // `src/learn/data/index.json` says `zh` and `ja`. A track that reaches the panel
  // as `zho` is matched by NO list, so every word renders unmarked — while the
  // track is discovered, named and offered exactly as if it worked.
  check('ISO 639-2 Chinese maps to zh', normaliseLanguage('zho'), 'zh');
  check('the bibliographic form too', normaliseLanguage('chi'), 'zh');
  check('Japanese', normaliseLanguage('jpn'), 'ja');
  check('English', normaliseLanguage('eng'), 'en');
  check('German, terminological', normaliseLanguage('deu'), 'de');
  check('German, bibliographic', normaliseLanguage('ger'), 'de');

  // Already correct codes pass through untouched rather than being rejected.
  check('a two-letter code is left alone', normaliseLanguage('zh'), 'zh');
  check('and Japanese', normaliseLanguage('ja'), 'ja');

  // A script or region subtag is meaningful and kept, with the BASE normalised.
  check('a script variant is kept', normaliseLanguage('zh-Hans'), 'zh-Hans');
  check('and its 639-2 form maps too', normaliseLanguage('zho-Hans'), 'zh-Hans');
  check('a region is kept lower-case', normaliseLanguage('zh-cn'), 'zh-cn');

  // `und`, and anything unrecognised, becomes null so callers report rather than
  // guess. Guessing here would mark a film with the wrong word list confidently.
  check('und is undetermined', normaliseLanguage('und'), null);
  check('empty is undetermined', normaliseLanguage(''), null);
  check('an unknown language is reported, not guessed', normaliseLanguage('xyz'), 'xyz');
}

if (!HAVE_FIXTURES) {
  // A SKIP that reports green is worse than no test: it says the parser works
  // while proving nothing. `test/fixtures/` is gitignored, so on a fresh clone
  // these files genuinely are absent — which makes `npm run fixtures` the fix, and
  // this message the thing that tells you so.
  console.log('\n  FAIL  the MKV fixtures are not present.');
  console.log('        They are generated, not committed. Run:  npm run fixtures');
  check('the MKV fixtures exist', false, true);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(1);
}

section('track discovery on a real three-track file');

{
  // Built by ffmpeg with `-metadata:s:s:N language=…`, so the language tags are
  // the muxer's own, not something this test wrote.
  const file = readerFor('three-tracks.mkv');
  const tracks = await readMatroskaTracks(file);

  check('all three subtitle tracks are found', tracks.length, 3);
  check('they are identified as text', tracks.map((t) => t.kind), ['text', 'text', 'text']);
  // The fixture's metadata says `eng`, `jpn`, `zho` — ISO 639-2, which is what
  // Matroska writes. These must arrive as `en`, `ja`, `zh`, which is what the
  // word lists use, or nothing would ever be marked.
  check('their languages are normalised for the word lists', tracks.map((t) => t.language), ['en', 'ja', 'zh']);
  check('their track numbers are read', tracks.every((t) => t.number > 0), true);
  // The codec id is the reason a track can be judged usable at all.
  check('and their codecs', tracks.every((t) => isTextCodec(t.codec)), true);
}

{
  // A file with no subtitle tracks must report NONE, not fail and not invent one.
  const tracks = await readMatroskaTracks(readerFor('no-subtitles.mkv'));
  check('a file with no subtitles reports none', tracks, []);
}

{
  // `und` is Matroska's own undetermined value. It is normalized to null rather
  // than passed through, so the panel has one thing to check and never receives
  // it as a language code it would then look up a word list for.
  const tracks = await readMatroskaTracks(readerFor('notag.mkv'));
  check('an undetermined language is null, not "und"', tracks.map((t) => t.language), [null]);
}

section('cue extraction from a real file');

{
  const file = readerFor('three-tracks.mkv');
  const names = (await readMatroskaTracks(file)).map((t) => t.number);
  const { cues, truncated } = await readMatroska({ ...file, trackNumbers: names });

  check('nothing was truncated', truncated, false);
  check('every track yielded cues', names.every((n) => (cues.get(n)?.length ?? 0) > 0), true);

  const english = cues.get(names[0]);
  check('the English track has two cues', english.length, 2);
  // The timing comes from the container's Block timestamp, not from the text —
  // the SRT we muxed in had no end times the container kept, so the durations are
  // whatever `BlockDuration` or the next cue provides.
  check('the first cue starts at 0.5s', english[0].start, 0.5);
  check('and carries its text', english[0].text, 'Hello there');
  check('the second cue follows', english[1].text, 'Second line');

  // The Chinese track was GBK on disk as an .srt and is UTF-8 inside the
  // container — the Matroska spec converts it. This asserts the conversion
  // happened, which is a fact about the format worth pinning.
  const chinese = cues.get(names[2]);
  check('the Chinese track is readable', chinese.length, 1);
  check('and its text survived as real characters', chinese[0].text, '你好，世界');

  const japanese = cues.get(names[1]);
  // `{\pos(320,240)}` was in the ASS we muxed in. Left in, it would be marked as
  // vocabulary.
  check('ASS override tags are stripped', japanese[0].text, 'Japanese line');
  check('and commas inside ASS text survive', japanese[1].text, 'Line with, a comma');
}

{
  // A file whose subtitle track is genuinely `S_TEXT/ASS` — not an SRT that
  // passed through a conversion. This is the case a film actually has.
  const file = readerFor('ass-track.mkv');
  const tracks = await readMatroskaTracks(file);

  check('the ASS track is found', tracks.length, 1);
  check('and its codec is ASS', tracks[0].codec, 'S_TEXT/ASS');
  check('with its language, normalised', tracks[0].language, 'ja');

  const { cues } = await readMatroska({ ...file, trackNumbers: [tracks[0].number] });
  const list = cues.get(tracks[0].number);

  check('its cues are extracted', list.length, 2);
  // The block holds only the event FIELDS — the `[Script Info]` and style blocks
  // live in the track's CodecPrivate — so the text is everything after the eighth
  // comma, and the override block inside it is styling rather than words.
  check('override tags are stripped', list[0].text, 'Japanese line');
  check('and a comma in the text survives', list[1].text, 'Line with, a comma');
}

{
  // Asking for one track must not read the others. This is what keeps a chosen
  // language cheap on a large file.
  const file = readerFor('three-tracks.mkv');
  const numbers = (await readMatroskaTracks(file)).map((t) => t.number);
  const { cues } = await readMatroska({ ...file, trackNumbers: [numbers[1]] });

  check('only the requested track is extracted', [...cues.keys()], [numbers[1]]);
}

section('reading is bounded, so a film is never held in memory');

{
  // The reader is given a file far larger than it is, and must only ever ask for
  // bytes that exist. This is the property that makes a multi-gigabyte film
  // workable: elements are walked by their declared size, so what is not needed
  // is never read.
  const real = readerFor('three-tracks.mkv');
  let reads = 0;
  let maxSingleRead = 0;

  const instrumented = {
    size: real.size,
    read: async (offset, length) => {
      reads++;
      maxSingleRead = Math.max(maxSingleRead, length);
      return real.read(offset, length);
    },
  };

  const tracks = await readMatroskaTracks(instrumented);
  check('discovery found the tracks', tracks.length, 3);
  // ONE read, and that is the whole point. `Tracks` precedes the clusters, so
  // discovery stops there rather than walking the media — which on this fixture
  // is measurable as "it never asked for a second window".
  //
  // Byte counts would NOT have shown this: the fixture is smaller than one window,
  // so a single read of `min(WINDOW, size)` already covers the file and "bytes
  // read" equals the file size either way. The read COUNT is the honest signal.
  check('discovery needed only one read', reads, 1);
  check('and never asked for more than one window', maxSingleRead <= 8 * 1024 * 1024, true);
}

{
  // A read that returns nothing must terminate rather than spin. A truncated
  // download or a file that shrank mid-read is the realistic case.
  const { tracks, cues } = await readMatroska({
    size: 1024 * 1024,
    read: async () => new Uint8Array(0),
  });
  check('an unreadable file yields no tracks', tracks, []);
  check('and no cues', cues.size, 0);

  // A file whose declared size runs past its real content: the walk must stop at
  // the first unreadable region rather than looping.
  const stub = readFileSync(join(FIXTURES, 'three-tracks.mkv'));
  const { tracks: partial } = await readMatroska({
    size: stub.length * 100,
    read: async (offset, length) => (offset > stub.length ? new Uint8Array(0) : stub.subarray(offset, offset + length)),
  });
  check('a declared size past the content does not hang', Array.isArray(partial), true);
}

section("the file's own TimecodeScale is used, not an assumed millisecond");

{
  // **The bug this pins.** Block timestamps are integer TICKS, and `TimecodeScale`
  // says how long a tick is. The parser used to divide by 1000, which is correct
  // only for the default of one millisecond — so a file with a different scale had
  // every timestamp wrong by that factor, silently, with a complete-looking
  // transcript.
  //
  // `ffmpeg` cannot write a non-default scale, so the fixture is a REAL container
  // with that single field rewritten in place. Same byte width (3), so nothing
  // shifts — the file stays valid and only the scale differs. That is more honest
  // than a hand-built container, and it is the only way to reach this case without
  // downloading the conformance suite's `test2.mkv`.
  const original = readFileSync(join(FIXTURES, 'three-tracks.mkv'));

  // `2A D7 B1` is the TimecodeScale id; the byte after it is a 1-byte size, then
  // the 3-byte value.
  const at = original.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
  check('the fixture carries a TimecodeScale element', at > 0, true);

  /** @param {Buffer} bytes */
  const readerOf = (bytes) => ({
    size: bytes.length,
    read: async (offset, length) => new Uint8Array(bytes.subarray(offset, offset + length)),
  });

  const standard = await readMatroska({ ...readerOf(original), trackNumbers: [] });
  check('the default scale is read as one millisecond', standard.timecodeScale, 1_000_000);

  // Rewrite it to 100,000 — the value CELLAR's test2.mkv uses. A correct parser now
  // reports timestamps TEN TIMES SMALLER, because each tick is a tenth as long.
  const patched = Buffer.from(original);
  patched.writeUIntBE(100_000, at + 4, 3);

  const scaled = await readMatroska({ ...readerOf(patched), trackNumbers: [] });
  check('a non-default scale is read from the file', scaled.timecodeScale, 100_000);

  const numbers = standard.tracks.map((t) => t.number);
  const base = await readMatroska({ ...readerOf(original), trackNumbers: [numbers[0]] });
  const fast = await readMatroska({ ...readerOf(patched), trackNumbers: [numbers[0]] });

  const baseStart = base.cues.get(numbers[0])?.[0]?.start;
  const fastStart = fast.cues.get(numbers[0])?.[0]?.start;

  check('the default file starts its first cue at 0.5s', baseStart, 0.5);
  check('and the ten-times-finer scale starts it at 0.05s', fastStart, 0.05);
  // Stated as the relationship, so the assertion says what it means: the scale was
  // applied rather than ignored.
  check('the two differ by exactly the scale ratio', Math.round(baseStart / fastStart), 10);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
