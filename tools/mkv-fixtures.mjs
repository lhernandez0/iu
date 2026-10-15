#!/usr/bin/env node
/**
 * Generate the MKV test fixtures.
 *
 * `test/mkv/` is gitignored and GENERATED rather than committed, so these files
 * do not exist on a fresh clone, which means `mkv-container.test.mjs` would SKIP
 * rather than fail, and a skipped parser test is worse than no parser test: it
 * reports green while proving nothing.
 *
 * Being generated is why they are not in `test/fixtures/` with the real captures:
 * that directory holds files which cannot be reproduced, and these can be rebuilt
 * in two seconds by anyone with `ffmpeg`.
 *
 * **Why generated files and not hand-written bytes:** a parser proven only against
 * fixtures its own author wrote has been proven against its author. A muxer writes
 * real EBML framing, real seek heads and real cluster timing, and is a far less
 * accommodating witness.
 *
 * Usage:  npm run fixtures
 *         node tools/mkv-fixtures.mjs [--force]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'mkv');
const force = process.argv.includes('--force');

if (!force && existsSync(join(OUT, 'three-tracks.mkv'))) {
  console.log('fixtures already present, pass --force to rebuild');
  process.exit(0);
}

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('ffmpeg is required to generate the MKV fixtures and was not found on PATH.');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

/**
 * Run ffmpeg, quietly.
 *
 * `-v error` rather than the default, which prints a stream of encoding statistics
 * that would bury the one line that matters if something fails. `-y` because the
 * script owns this directory and a stale file should be replaced rather than
 * prompting, which would hang.
 *
 * @param {string[]} args
 */
function ffmpeg(args) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: OUT, stdio: 'inherit' });
}

// --- Source subtitle files ---------------------------------------------------
//
// Written here because they are inputs to the fixtures, not fixtures themselves,
// and a reader of the generator should be able to see exactly what text ends up in
// each track.

const ENGLISH_SRT = `1
00:00:00,500 --> 00:00:02,500
Hello there

2
00:00:03,000 --> 00:00:05,000
Second line
`;

// Chinese, written as UTF-8. The equivalent SIDECAR case is tested with GBK bytes
// in `reader.test.mjs`, because a sidecar file is where that trap lives, inside a
// container the text is UTF-8 by specification.
const CHINESE_SRT = `1
00:00:00,500 --> 00:00:02,500
你好，世界
`;

// The ASS source, used by two fixtures. It deliberately contains an override block
// AND a comma inside the text: two things a naive parser gets wrong, and the
// comma is the one that truncates every line silently.
const JAPANESE_ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:02.50,Default,,0,0,0,,{\\pos(320,240)}Japanese line
Dialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,Line with, a comma
`;

const UNTAGGED_SRT = `1
00:00:00,500 --> 00:00:02,500
No language tag here
`;

/**
 * A long SRT whose cues are spread across ten minutes.
 *
 * **This exists to prove the caption INDEX bounds the read, which no short fixture can.**
 * The windowed first pass reads only the clusters for a window of time, so the property to
 * test is that a cue EARLY in the file is readable without reading the whole thing, and a
 * cue ten minutes in is still reachable. A six-second fixture has one cluster and proves
 * neither. The cues are one every 30 seconds so a window and the full file are clearly
 * different lists.
 *
 * `label` distinguishes two long tracks in one file: a study track and a gloss track whose
 * text is different, so a test can tell which line is which rather than seeing the same
 * words on both.
 *
 * @param {number} count
 * @param {string} [label]
 */
function longSrt(count, label = 'Line') {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const start = i * 30;
    const stamp = (s) => {
      const m = String(Math.floor(s / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      return `00:${m}:${sec},000`;
    };
    rows.push(`${i + 1}\n${stamp(start)} --> ${stamp(start + 4)}\n${label} ${i + 1} long\n`);
  }
  return rows.join('\n');
}

/**
 * A long CHINESE track, ten minutes, cues every 30 seconds.
 *
 * **Chinese because the difficulty band is painted from the MARKS a word list produces.**
 * The band is held back until the whole film is read, and the test for that needs a film
 * long enough to need the background fill AND a study track a word list can actually mark.
 * English has no list, so an English fixture would draw no band whether the read was done or
 * not, and a test on it would pass while asserting nothing. The text is real Chinese so the
 * marks are real, not a stub the dictionary happens to skip.
 *
 * @param {number} count
 */
function longChineseSrt(count) {
  const rows = [];
  // Enough distinct sentences that the band is not one level for the whole film, which
  // would make it a single span and hide a paint that produced one block.
  const lines = ['你好，世界', '我喜欢学习中文', '今天天气很好', '他去了学校', '我们喝茶吧'];
  for (let i = 0; i < count; i++) {
    const start = i * 30;
    const stamp = (s) => {
      const m = String(Math.floor(s / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      return `00:${m}:${sec},000`;
    };
    rows.push(`${i + 1}\n${stamp(start)} --> ${stamp(start + 4)}\n${lines[i % lines.length]}\n`);
  }
  return rows.join('\n');
}

writeFileSync(join(OUT, 'en.srt'), ENGLISH_SRT);
writeFileSync(join(OUT, 'zh.srt'), CHINESE_SRT);
writeFileSync(join(OUT, 'ja.ass'), JAPANESE_ASS);
writeFileSync(join(OUT, 'untagged.srt'), UNTAGGED_SRT);
writeFileSync(join(OUT, 'long.srt'), longSrt(20));
// Two long tracks with different text, for the fixture where the SECOND line and the
// windowed fill meet. See `long-dual.mkv`.
writeFileSync(join(OUT, 'long-study.srt'), longSrt(20, 'Study'));
writeFileSync(join(OUT, 'long-gloss.srt'), longSrt(20, 'Gloss'));
// A long CHINESE track, for the band fixture. Chinese on purpose: the band is painted from
// the marks a word list produces, and a track in a language with no list would draw no band
// however long the film is, which would make a band test pass or fail for the wrong reason.
writeFileSync(join(OUT, 'long-zh.srt'), longChineseSrt(20));

// --- The fixtures ------------------------------------------------------------
//
// `testsrc` is a synthesised pattern. Small and short on purpose: these exist to
// exercise a parser, not to be watched, and a fixture measured in megabytes would
// make the suite slow without testing anything more.

/** The video stream every fixture shares. `-an` because audio is irrelevant here. */
const VIDEO = ['-f', 'lavfi', '-i', 'testsrc=duration=6:size=192x108:rate=5'];
const SHORT_VIDEO = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=128x72:rate=5'];

console.log('three-tracks.mkv, three text tracks with real language metadata');
ffmpeg([
  ...VIDEO,
  '-i', 'en.srt',
  '-i', 'ja.ass',
  '-i', 'zh.srt',
  '-map', '0:v', '-map', '1', '-map', '2', '-map', '3',
  '-c:v', 'libx264', '-preset', 'ultrafast',
  // `-c:s srt` for every subtitle stream: the ASS source is converted on the way
  // in, which is what a real SRT track looks like inside a container. The genuine
  // ASS case is `ass-track.mkv` below.
  '-c:s', 'srt',
  '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English',
  '-metadata:s:s:1', 'language=jpn', '-metadata:s:s:1', 'title=Japanese',
  '-metadata:s:s:2', 'language=zho', '-metadata:s:s:2', 'title=Chinese',
  'three-tracks.mkv',
]);

console.log('ass-track.mkv, a genuine S_TEXT/ASS track');
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=duration=6:size=128x72:rate=5',
  '-i', 'ja.ass',
  '-map', '0:v', '-map', '1',
  '-c:v', 'libx264', '-preset', 'ultrafast',
  // `-c:s ass` is what keeps it ASS rather than converting it. An ASS block holds
  // only the event fields, with `[Script Info]` in the track's `CodecPrivate`, so
  // the parsing path is different from SRT and needs its own fixture.
  '-c:s', 'ass',
  '-metadata:s:s:0', 'language=jpn',
  '-metadata:s:s:0', 'title=Japanese',
  'ass-track.mkv',
]);

console.log('two-audio.mkv, two audio tracks, and LONG enough to seek into');
// The only fixture with audio, and the only one long enough for a position test.
//
// Both matter: `three-tracks.mkv` is SIX SECONDS, which cannot show a re-source losing a
// playback position, and produced two misleading tests before this existed (see
// `test/browser/viewer.test.mjs`). It is synthesised tones rather than speech, so the
// two tracks are distinguishable by ear AND by frequency analysis.
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=duration=300:size=192x108:rate=5',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=300',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=300',
  '-map', '0:v', '-map', '1:a', '-map', '2:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  '-shortest',
  'two-audio.mkv',
]);

console.log('no-subtitles.mkv, a file with no subtitle tracks at all');
ffmpeg([
  ...SHORT_VIDEO,
  '-c:v', 'libx264', '-preset', 'ultrafast',
  '-an',
  'no-subtitles.mkv',
]);

console.log('notag.mkv, language=und, Matroska\'s own "undetermined"');
ffmpeg([
  ...SHORT_VIDEO,
  '-i', 'untagged.srt',
  '-map', '0:v', '-map', '1',
  '-c:v', 'libx264', '-preset', 'ultrafast',
  '-c:s', 'copy',
  '-metadata:s:s:0', 'language=und',
  'notag.mkv',
]);

// **There is no `unnamed.mkv`, and that is deliberate.**
//
// The case worth testing is a track with NO `Language` element at all, which
// Matroska defines as English, and `ffmpeg` cannot produce it. Omitting the
// metadata does not omit the element; it writes `und` instead, so an "unnamed"
// fixture built this way is byte-for-byte a duplicate of `notag.mkv`. That was the
// case until this comment existed, and the two were reported as separate coverage
// while testing exactly the same bytes.
//
// So the absent case is reached by editing a real file instead: `Void` (0xEC) is
// the element the format provides for exactly this, and one of the same length
// replaces the language without shifting a single byte, see the test.

// **The Dolby fixtures, which the decoder is tested against.**
//
// AC-3 and E-AC-3 are the codecs the browser cannot decode at all, which is the whole
// reason the bundled decoder exists, and the fixtures are the only way to prove it
// works. `one-eac3.mkv` is a single mono track, enough to check the decode.
//
// `six-eac3.mkv` is 5.1 and LONGER THAN THE DECODER'S BUFFER WINDOW, and both of those
// matter. A 6-channel track is what a real film carries, and a short file cannot show a
// refill bug: the whole thing fits in the first window, so the reader never has to
// continue. A decoder that stops after the first window passes on a three second file
// and fails on a film, which is exactly the bug that reached a user.
console.log('one-eac3.mkv, a single E-AC-3 track the browser cannot decode');
ffmpeg([
  ...SHORT_VIDEO,
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'eac3',
  '-shortest',
  'one-eac3.mkv',
]);

console.log('six-eac3.mkv, 5.1 E-AC-3 and longer than the decoder refill window');
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=duration=30:size=160x90:rate=5',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
  '-map', '0:v', '-map', '1:a',
  '-af', 'pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'eac3',
  '-shortest',
  'six-eac3.mkv',
]);

// **DTS, the third codec WebCodecs lacks.** ADR 0013 put it in scope and reversed the
// earlier belief that no permissively-licensed DTS decoder existed; `@mediabunny/dts` is
// MPL-2.0 like the others, and this fixture is what proves the registration actually
// works rather than assuming it. `dca` is ffmpeg's DTS encoder, and `-strict -2` is
// required because it is still flagged experimental, which the flag says nothing about
// the file being playable, only about ffmpeg's confidence in the encoder.
console.log('one-dts.mkv, a single DTS track the browser cannot decode');
ffmpeg([
  ...SHORT_VIDEO,
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'dca', '-strict', '-2',
  '-shortest',
  'one-dts.mkv',
]);

// **Ten minutes with a caption every 30 seconds, to test the caption INDEX.** The windowed
// first pass reads only the cluster range its `Cues` index names, so the property worth
// pinning is that a cue early in the file is available quickly and a cue late in it is
// still reachable, which needs a file long enough to have many clusters and cues spread
// across them. Silent, because the captions are the subject.
console.log('long-subs.mkv, ten minutes with cues spread across it');
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=duration=600:size=160x90:rate=5',
  '-i', 'long.srt',
  '-map', '0:v', '-map', '1',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:s', 'srt',
  '-metadata:s:s:0', 'language=eng',
  'long-subs.mkv',
]);

// **Ten minutes AND two subtitle tracks, which is the combination the existing fixtures
// each missed one half of.** `long-subs.mkv` windows but has no second track, so nothing
// asserted the second line against a growing study list; `three-tracks.mkv` has a second
// track but is six seconds, which one window covers, so the fill never ran. A blank second
// line partway through a long film needed BOTH to be caught, and neither fixture had both.
console.log('long-dual.mkv, ten minutes with a study track and a gloss track');
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=duration=600:size=160x90:rate=5',
  '-i', 'long-study.srt',
  '-i', 'long-gloss.srt',
  '-map', '0:v', '-map', '1', '-map', '2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:s', 'srt',
  // The STUDY track is Japanese and the gloss English. That order matters: the viewer picks
  // a MARKABLE language for the study line when nothing is stored, Japanese is markable and
  // English is not, so the study line lands on the Japanese track by itself and the gloss is
  // then chosen from the ENGLISH one. With the languages the other way the auto-pick takes
  // the gloss track as the study line, and selecting the gloss hits the same-track guard and
  // is dropped, which is a test that would pass while asserting nothing.
  '-metadata:s:s:0', 'language=jpn', '-metadata:s:s:0', 'title=Study',
  '-metadata:s:s:1', 'language=eng', '-metadata:s:s:1', 'title=Gloss',
  'long-dual.mkv',
]);

// **Ten minutes with a MARKABLE study track, for the difficulty band's timing.** The band
// is painted from marks, so this is the only long fixture where a band can appear at all:
// `long-subs.mkv` and `long-dual.mkv` are both text a word list cannot mark, and their band
// is empty however the timing works. Chinese, because that is a language the bundled lists
// cover.
console.log('long-band.mkv, ten minutes with a markable Chinese track');
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=duration=600:size=160x90:rate=5',
  '-i', 'long-zh.srt',
  '-map', '0:v', '-map', '1',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:s', 'srt',
  '-metadata:s:s:0', 'language=zho',
  'long-band.mkv',
]);

// The source subtitle files are inputs, not fixtures, every one of them is
// embedded in a container above, so leaving them loose would put four stray files
// in the directory for no reason.
for (const temp of ['en.srt', 'zh.srt', 'ja.ass', 'untagged.srt', 'long.srt', 'long-study.srt', 'long-gloss.srt', 'long-zh.srt']) {
  rmSync(join(OUT, temp), { force: true });
}
console.log('\nfixtures written to test/mkv/');
