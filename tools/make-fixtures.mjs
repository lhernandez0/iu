#!/usr/bin/env node
/**
 * Generate the MKV test fixtures.
 *
 * `test/fixtures/` is gitignored, so these files do not exist on a fresh clone —
 * which means `matroska.test.mjs` would SKIP rather than fail, and a skipped parser
 * test is worse than no parser test: it reports green while proving nothing.
 *
 * So the files are generated rather than committed, and this is the generator.
 * `ffmpeg` is the only requirement. Everything is a synthesised test pattern, so
 * no third-party media is involved.
 *
 * **Why generated files and not hand-written bytes:** a parser proven only against
 * fixtures its own author wrote has been proven against its author. A muxer writes
 * real EBML framing, real seek heads and real cluster timing, and is a far less
 * accommodating witness.
 *
 * Usage:  npm run fixtures
 *         node tools/make-fixtures.mjs [--force]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'fixtures');
const force = process.argv.includes('--force');

if (!force && existsSync(join(OUT, 'three-tracks.mkv'))) {
  console.log('fixtures already present — pass --force to rebuild');
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
// in `reader.test.mjs`, because a sidecar file is where that trap lives — inside a
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

writeFileSync(join(OUT, 'en.srt'), ENGLISH_SRT);
writeFileSync(join(OUT, 'zh.srt'), CHINESE_SRT);
writeFileSync(join(OUT, 'ja.ass'), JAPANESE_ASS);
writeFileSync(join(OUT, 'untagged.srt'), UNTAGGED_SRT);

// --- The fixtures ------------------------------------------------------------
//
// `testsrc` is a synthesised pattern. Small and short on purpose: these exist to
// exercise a parser, not to be watched, and a fixture measured in megabytes would
// make the suite slow without testing anything more.

/** The video stream every fixture shares. `-an` because audio is irrelevant here. */
const VIDEO = ['-f', 'lavfi', '-i', 'testsrc=duration=6:size=192x108:rate=5'];
const SHORT_VIDEO = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=128x72:rate=5'];

console.log('three-tracks.mkv — three text tracks with real language metadata');
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

console.log('ass-track.mkv — a genuine S_TEXT/ASS track');
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

console.log('no-subtitles.mkv — a file with no subtitle tracks at all');
ffmpeg([
  ...SHORT_VIDEO,
  '-c:v', 'libx264', '-preset', 'ultrafast',
  '-an',
  'no-subtitles.mkv',
]);

console.log('notag.mkv — language=und, Matroska\'s own "undetermined"');
ffmpeg([
  ...SHORT_VIDEO,
  '-i', 'untagged.srt',
  '-map', '0:v', '-map', '1',
  '-c:v', 'libx264', '-preset', 'ultrafast',
  '-c:s', 'copy',
  '-metadata:s:s:0', 'language=und',
  'notag.mkv',
]);

console.log('unnamed.mkv — no Language element at all, which is not the same as und');
ffmpeg([
  ...SHORT_VIDEO,
  '-i', 'en.srt',
  '-map', '0:v', '-map', '1',
  '-c:v', 'libx264', '-preset', 'ultrafast',
  '-c:s', 'copy',
  'unnamed.mkv',
]);

// The source subtitle files are inputs, not fixtures — every one of them is
// embedded in a container above, so leaving them loose would put four stray files
// in the directory for no reason.
for (const temp of ['en.srt', 'zh.srt', 'ja.ass', 'untagged.srt']) {
  rmSync(join(OUT, temp), { force: true });
}

console.log('\nfixtures written to test/fixtures/');
