#!/usr/bin/env node
/**
 * Make a browser-playable copy of the real sample, for the player preview.
 *
 * **The video is still the real thing**, CELLAR's test5.mkv, which is Big Buck
 * Bunny (Blender Foundation, CC-BY). This REMUXES it into MP4, which is a
 * container change and not a re-encode: `-c copy` moves the existing H.264 and AAC
 * streams across untouched, so it takes about a second and loses nothing.
 *
 * ## Why this exists
 *
 * The VS Code integrated browser cannot play the Matroska container at all.
 * Measured: H.264 in MP4 plays, H.264 in MKV does not, and neither does VP9 in MKV
 *, so it is the container and not the codec. The failure is `media error 4`
 * (`SRC_NOT_SUPPORTED`) with `net::ERR_ABORTED`, which reads like a codec problem
 * and is not one.
 *
 * This matters beyond the preview: **MKV is the format the reader exists for, and
 * it cannot be checked by hand in that browser.** Use real Chrome for the MKV
 * path. For the player layout, which is what the preview is for, MP4 is
 * equivalent, because the bar does not know what container it is over.
 *
 * Usage:  node tools/ui/make-preview-video.mjs [--force]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SOURCE = join(ROOT, 'test', 'conformance', 'test5.mkv');
const OUT = join(HERE, 'assets');
const NAME = 'preview.mp4';
const force = process.argv.includes('--force');

if (!force && existsSync(join(OUT, NAME))) {
  console.log(`${NAME} already present, pass --force to rebuild`);
  process.exit(0);
}

if (!existsSync(SOURCE)) {
  console.error(`No ${SOURCE}.`);
  console.error('Run `npm run conformance:fetch` first, it downloads the CC-BY sample.');
  process.exit(1);
}

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('ffmpeg is required to remux the preview video and was not found on PATH.');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

execFileSync(
  'ffmpeg',
  [
    '-v', 'error',
    '-y',
    '-i', SOURCE,
    // Video and audio only. The subtitle tracks are what the reader reads, but the
    // preview's cue list comes from the SIDECAR written below, and MP4 cannot carry
    // SubRip anyway, `mov_text` is a different format.
    '-map', '0:v:0',
    '-map', '0:a:0',
    // The one thing that cannot be stream-copied. H.264 and AAC both move across
    // untouched; the H.264 in this file is High profile, and MP4 wants a codec tag
    // it can advertise. `-c copy` keeps the encoded frames.
    '-c', 'copy',
    '-movflags', '+faststart',
    NAME,
  ],
  { cwd: OUT, stdio: 'inherit' },
);

console.log(`wrote ${join(OUT, NAME)} (remuxed from ${SOURCE}, no re-encode)`);

// --- The real cue list, as a sidecar -----------------------------------------
//
// The preview shows the strip BELOW the picture and it has to show the real lines,
// or it is a mock of a subtitle feature with fake subtitles. So the file's own
// first subtitle track is extracted here, real text, real timing, and the mock
// fetches it.
//
// `-map 0:s:0` is English in this file. It is worth knowing that test5 is a
// VALIDATION file: its tracks are deliberately odd (the one tagged `jpn` holds
// Italian), so the language of this sidecar is "whatever track 0 is", not a claim
// about what language it is.

const SRT = 'preview.en.srt';
execFileSync(
  'ffmpeg',
  ['-v', 'error', '-y', '-i', SOURCE, '-map', '0:s:0', '-f', 'srt', SRT],
  { cwd: OUT, stdio: 'inherit' },
);

console.log(`wrote ${join(OUT, SRT)} (the file's own subtitle track, for the caption strip)`);
console.log('MKV itself needs real Chrome, the VS Code browser cannot play the container.');
