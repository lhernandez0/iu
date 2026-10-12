/**
 * Rebuild the GitHub Pages demo's media from archive.org.
 *
 *   node tools/pages/fetch-media.mjs
 *
 * The four files it writes (`demo.mp4` and three subtitle tracks) are COMMITTED,
 * because the demo is what gets deployed and a deploy that fetches its own content
 * from an intermittently failing third party is a deploy that breaks for reasons
 * unrelated to the code. This script exists to make them REPRODUCIBLE, so the
 * committed bytes can be checked against their source rather than taken on trust,
 * the same standard the dictionaries are held to.
 *
 * Run it to refresh the clip, or to verify the committed copy: `demo.mp4` rebuilds
 * byte-identical. See `THIRD-PARTY.md` for the licence and the full provenance.
 *
 * ## The source
 *
 * *Princess Iron Fan* (鐵扇公主, 1941), the first Chinese animated feature, from
 * `archive.org/details/princess_iron_fan`. The archive item is marked
 * `creativecommons.org/licenses/publicdomain`, so no attribution is legally
 * required; it is given because the recipe is what makes the bytes checkable.
 *
 * The 8:00-13:00 window is used because that is where the subtitle cue density is
 * highest (38-39 cues in five minutes), so the demo shows the marking working on
 * real dialogue rather than on a title card.
 *
 * ## The video is a STREAM COPY, and that is deliberate
 *
 * `-c copy` re-muxes the source bytes without re-encoding, so the video is
 * bit-identical to the archive's and the file is SMALLER than any re-encode.
 * Measured, all at 640x480: source 31 MB, x264 CRF18 74 MB, x265 CRF22 58 MB, VP9
 * CRF32 48 MB. The source is already only 878 kbps, so a "near-lossless" re-encode
 * preserves its existing artifacts and costs MORE bits than the original encoder
 * spent. Only lossy re-encodes (CRF 30+) go below it, and those are not lossless.
 *
 * ## The subtitles are CUT AND REBASED
 *
 * The archive's `.srt` files cover the whole 73-minute film, so their cues run to
 * 1:13:00 and mean nothing against a five-minute clip. Each is filtered to the
 * window and its timestamps shifted back by `START_SECONDS`, so the first cue lands
 * at 00:00:06 rather than 00:08:06. Getting this wrong does not error, the
 * subtitles simply never appear, which looks like the marking being broken.
 *
 * ## Retries
 *
 * archive.org returns a 5XX for this item intermittently (observed). ffmpeg exits
 * non-zero and writes nothing, so a single attempt fails for a reason that is not
 * the code. Retrying is the difference between a flaky script and a usable one, and
 * it cost one confusing failure to learn.
 */

import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const MEDIA = resolve(here, 'media');

const BASE = 'https://archive.org/download/princess_iron_fan';

/** The window, in seconds, matching the cue-density peak at 8:00. */
const START_SECONDS = 480;
const DURATION_SECONDS = 300;
const END_SECONDS = START_SECONDS + DURATION_SECONDS;

/** Attempts per fetch. archive.org fails intermittently; two retries is enough. */
const ATTEMPTS = 3;

/**
 * The subtitle tracks, as `[remote name, local name]`.
 *
 * The LOCAL name matters: `languageFromFileName` in `src/viewer/subtitles.js`
 * reads the language from the filename, and it splits on `.` and `_` but NOT on
 * hyphens, so the full tag has to be the final dotted segment (`demo.zh-Hant.srt`,
 * not `demo-zh-hant.srt`, which would resolve to the bare `zh` and collide with
 * the other Chinese track, which the viewer then silently drops).
 *
 * English is included so the two-line study view has a second language to show.
 */
const SUBTITLES = [
  ['princess_iron_fan.srt', 'demo.en.srt'],
  ['princess_iron_fan-zh-hans.srt', 'demo.zh-Hans.srt'],
  ['princess_iron_fan-zh-hant.srt', 'demo.zh-Hant.srt'],
];

/** `00:01:02,500` -> seconds, or null. */
function parseTime(text) {
  const match = /^(\d+):(\d\d):(\d\d)[,.](\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, h, m, s, ms] = match;
  const millis = Number(ms.padEnd(3, '0').slice(0, 3));
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + millis / 1000;
}

/** Seconds -> `00:01:02,500`. */
function formatTime(total) {
  const ms = Math.round(Math.max(0, total) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`
  );
}

/**
 * Cut a full-length SRT to the window and rebase it to zero.
 *
 * A cue is kept when it OVERLAPS the window, and its bounds are clamped to it, so
 * a line straddling the start or end is not lost and does not extend past the
 * clip. Renumbered from 1 because the original indices would have gaps.
 *
 * @param {string} srt
 * @returns {{ text: string, cues: number }}
 */
function cutSubtitles(srt) {
  // Strip a BOM: the archive's Chinese files have one, and left in place it becomes
  // part of the first cue's index, which then reads as a malformed block.
  const blocks = srt.replace(/^\uFEFF/, '').trim().split(/\r?\n\s*\r?\n/);
  /** @type {string[]} */
  const out = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length < 2) continue;

    const timing = /^(.+?)\s*-->\s*(.+?)(\s.*)?$/.exec(lines[1]);
    if (!timing) continue;

    const start = parseTime(timing[1]);
    const end = parseTime(timing[2]);
    if (start === null || end === null) continue;
    if (end <= START_SECONDS || start >= END_SECONDS) continue;

    const cueStart = Math.max(start, START_SECONDS) - START_SECONDS;
    const cueEnd = Math.min(end, END_SECONDS) - START_SECONDS;
    const body = lines.slice(2).join('\n');

    out.push(`${out.length + 1}\n${formatTime(cueStart)} --> ${formatTime(cueEnd)}\n${body}`);
  }

  return { text: out.length ? `${out.join('\n\n')}\n` : '', cues: out.length };
}

/** @param {string} url @param {number} [attempts] @returns {Promise<string>} */
async function download(url, attempts = ATTEMPTS) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // `encoding: 'utf8'` so stdout is a string; the default is a Buffer.
      const { stdout } = await run(
        'curl',
        ['--fail', '--silent', '--show-error', '--location', url],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout;
    } catch (error) {
      last = error;
      console.error(`  attempt ${attempt}/${attempts} failed for ${url}`);
      // Back off, so a momentary 5XX has time to clear.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000 * attempt));
    }
  }
  throw last;
}

/**
 * Cut the window out of the remote video with a stream copy.
 *
 * ffmpeg seeks the remote file with HTTP range requests, so this reads only the
 * bytes the window needs rather than downloading the whole 433 MB film.
 *
 * ## Written to a temporary file, then renamed
 *
 * ffmpeg opens the output and TRUNCATES it before it has read the input, so a run
 * that fails part way, which archive.org's intermittent 5XX causes, leaves the
 * target at 0 bytes. Writing straight to `demo.mp4` therefore DESTROYS a good clip
 * on a failed refresh: observed, the file went from 31 MB to 0. The temp file is
 * that fix, and the size floor is the second half of it, because ffmpeg can also
 * exit 0 having written a partial file.
 *
 * @returns {Promise<number>} the written size in bytes
 */
async function fetchVideo() {
  const target = join(MEDIA, 'demo.mp4');
  // Same directory, so the rename is atomic within one filesystem.
  const temp = join(MEDIA, 'demo.mp4.part');
  let last;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await run('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', String(START_SECONDS),
        '-i', `${BASE}/princess_iron_fan.mp4`,
        '-t', String(DURATION_SECONDS),
        // The whole point: re-mux, do not re-encode.
        '-c', 'copy',
        // Required, not cosmetic: ffmpeg infers the container from the output
        // EXTENSION, and the temp file ends in `.part`, so without this it refuses
        // with "Unable to find a suitable output format".
        '-f', 'mp4',
        '-movflags', '+faststart',
        '-y', temp,
      ]);

      const { size } = await stat(temp);
      // Five minutes of 640x480 video is megabytes, so anything under a megabyte is
      // a truncated read, not a small clip. A floor rather than `> 0`, which a
      // 1-byte file would pass.
      if (size < 1024 * 1024) throw new Error(`ffmpeg wrote only ${size} bytes`);

      // Only now is the good file replaced.
      await rename(temp, target);
      return size;
    } catch (error) {
      last = error;
      await rm(temp, { force: true });
      console.error(`  attempt ${attempt}/${ATTEMPTS} failed for the video: ${error?.message ?? error}`);
      if (attempt < ATTEMPTS) {
        // Back off, so a momentary 5XX has time to clear.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000 * attempt));
      }
    }
  }
  throw last;
}

async function main() {
  await mkdir(MEDIA, { recursive: true });

  const size = await fetchVideo();
  console.log(`  demo.mp4 (${(size / 1024 / 1024).toFixed(1)} MB, lossless stream copy)`);

  for (const [remote, local] of SUBTITLES) {
    const { text, cues } = cutSubtitles(await download(`${BASE}/${remote}`));
    if (!cues) {
      throw new Error(`${remote} produced no cues in the ${START_SECONDS}s-${END_SECONDS}s window`);
    }
    await writeFile(join(MEDIA, local), text, 'utf8');
    console.log(`  ${local} (${cues} cues)`);
  }

  console.log(`wrote ${MEDIA}`);
}

await main();
