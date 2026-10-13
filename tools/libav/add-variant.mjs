/**
 * Add the `iu` variant to a libav.js checkout.
 *
 *   node tools/libav/add-variant.mjs <libav.js-checkout> [--audio-only]
 *
 * libav.js has no plugin mechanism: a new build variant is an entry in
 * `configs/mkconfigs.js`. This script writes that entry, because hand-editing a
 * file that large is the step that made the first build unreproducible.
 *
 * Idempotent: re-running replaces the previous block instead of appending a
 * second one.
 *
 * `--audio-only` omits the video decoders and their parsers. Measured: they cost
 * 2.39 MB raw / 0.83 MB gzipped, so a release that does not yet decode video
 * should not carry them. `tools/build-libav.mjs` passes this through.
 *
 * `tools/build-libav.mjs` is the caller. Run this directly only when debugging
 * the variant definition itself.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const AUDIO_ONLY = args.includes('--audio-only');

if (!src) {
  console.error('usage: node tools/libav/add-variant.mjs <libav.js checkout> [--audio-only]');
  process.exit(1);
}
const file = join(src, 'configs', 'mkconfigs.js');

/**
 * Fragments the build needs, grouped by why.
 *
 * Each name is a libav.js fragment (`configs/fragments/`) that maps to FFmpeg
 * configure flags. The grouping is by REASON, because the reason is what has to
 * survive the next edit; the flags are derived and can be read in
 * `tools/libav/ffmpeg-config.txt`.
 *
 * `video` is the set `--audio-only` removes, together with the video parsers.
 */
const GROUPS = {
  core: ['avformat', 'avcodec', 'avfilter', 'swresample', 'swscale', 'avfcbridge'],

  containers: [
    'demuxer-mpegts', 'demuxer-avi', 'demuxer-asf', 'demuxer-flv',
    'demuxer-matroska', 'demuxer-mp4', 'demuxer-mpeg', 'demuxer-ogg',
    'demuxer-wav', 'demuxer-flac',
  ],

  // AC-3 and E-AC-3 are SEPARATE decoders in FFmpeg: "ac3" is Dolby Digital,
  // "eac3" is Dolby Digital Plus, and enabling one does NOT give you the other. A
  // build with only ac3 demuxes an eac3 file, reports both streams, and then fails
  // at ff_init_decoder with "Codec not found", because the decoder is genuinely
  // not in the binary. Cost a debugging cycle; written down so it costs one and
  // not two.
  audio: [
    'decoder-ac3', 'decoder-eac3', 'parser-ac3',
    'decoder-aac', 'parser-aac',
    'decoder-mp3', 'parser-mpegaudio',
    'decoder-opus', 'parser-opus',
    'decoder-flac', 'parser-flac',
    'decoder-vorbis', 'parser-vorbis',
    'decoder-wmav1', 'decoder-wmav2', 'decoder-wmapro', 'decoder-wmalossless',
    'decoder-cook', 'decoder-sipr', 'decoder-ra_144', 'decoder-ra_288',
    'decoder-dvaudio', 'decoder-wavpack', 'decoder-alac',
    'decoder-pcm_s16le', 'decoder-pcm_s24le', 'decoder-pcm_s32le',
    'decoder-pcm_f32le', 'codec-pcm_f32le', 'decoder-pcm_s16be',
    'decoder-pcm_s24be', 'decoder-pcm_f64le', 'decoder-pcm_u8',
    'decoder-pcm_s8',

    // **The ENCODER, and it is the point of the whole output design.**
    //
    // Decoding produces raw PCM, and PCM has nowhere useful to go: it cannot be handed
    // to a media element at a sane size, so without an encoder the only way to play it
    // is Web Audio, which means owning the audio clock and keeping it in step with the
    // video ourselves. That is where every bug in this feature lived.
    //
    // Encoding it back to AAC means the audio can be muxed with the video and given to
    // the element as ONE stream, so the element owns seeking, pausing, sync and speed.
    // The cost is a re-encode, which is lossy on audio that was already lossy, and for
    // speech in a learning tool that is inaudible.
    //
    // FFmpeg's own `aac` encoder, so no external library and no licence change: this
    // build stays LGPL-2.1. `encoder-aac` and `codec-aac` are both named because the
    // fragment system splits `codec-<name>` into a decoder and an encoder and this
    // variant needs the encoder half explicitly.
    'encoder-aac', 'codec-aac',
  ],

  // HEVC is the one that matters most: the common codec in high definition
  // releases that the browser will not decode, measured as failing with
  // `error: 4` even though `canPlayType` says "probably".
  video: [
    'decoder-hevc', 'parser-hevc',
    'decoder-h264', 'parser-h264',
    'decoder-mpeg1video', 'decoder-mpeg2video', 'parser-mpegvideo',
    'decoder-mpeg4', 'parser-mpeg4video',
    'decoder-msmpeg4v1', 'decoder-msmpeg4v2', 'decoder-msmpeg4v3',
    'decoder-wmv1', 'decoder-wmv2', 'decoder-wmv3',
    'decoder-vc1', 'decoder-vp8', 'parser-vp8', 'decoder-vp9', 'parser-vp9',
    'decoder-theora', 'decoder-dvvideo', 'decoder-prores',
    'decoder-indeo2', 'decoder-indeo3', 'decoder-indeo4', 'decoder-indeo5',
  ],

  // Read one container, write another. Remuxing needs no decoders, so this group
  // stays in an audio-only build: it is what makes TS/AVI/ASF reachable when the
  // codecs inside are ones the browser can already play.
  remux: [
    'muxer-mp4', 'muxer-matroska', 'muxer-webm', 'muxer-wav', 'muxer-ogg',
    'audio-filters', 'video-filters',
    'avbsf', 'bsf-extract_extradata',
    'bsf-h264_mp4toannexb', 'bsf-hevc_mp4toannexb',
    'bsf-vp9_metadata', 'bsf-av1_metadata',
  ],
};

/**
 * @param {string[]} names
 * @param {number} indent
 */
function list(names, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  let line = pad;
  for (const name of names) {
    const piece = `"${name}",`;
    if (line.length + piece.length + 1 > 78) {
      lines.push(line.trimEnd());
      line = pad;
    }
    line += `${piece} `;
  }
  if (line.trim()) lines.push(line.trimEnd().replace(/,$/, ''));
  return lines.join('\n');
}

const fragments = [
  ...GROUPS.core,
  ...GROUPS.containers,
  ...GROUPS.audio,
  ...(AUDIO_ONLY ? [] : GROUPS.video),
  ...GROUPS.remux,
];

const BLOCK = `    // IU: the variant this project builds. Everything a media player needs that a
    // browser does not already decode: the containers it will not open, the Dolby
    // audio codecs, and ${AUDIO_ONLY ? 'the legacy audio formats' : 'HEVC and the legacy formats'}.
    //
    // DTS is deliberately absent. libav.js has no dca/dts fragment, and the
    // non-GPL DTS decoder situation is a separate project. Out of scope, said
    // out loud here so nobody discovers it from a bug report.
    //
    // Generated by tools/libav/add-variant.mjs${AUDIO_ONLY ? ' with --audio-only' : ''}.
    // Do not edit here; edit the groups in that script.
    ["iu", [
${list(fragments, 8)}
    ], {avf: true}],

`;

const MARKER = '    // IU: the variant this project builds.';

let text = readFileSync(file, 'utf8');

// Remove a previous block first, so this is idempotent. Everything from our
// marker up to the next variant entry is ours to replace.
const start = text.indexOf(MARKER);
if (start !== -1) {
  const end = text.indexOf('    ["empty", []],', start);
  if (end === -1) throw new Error('could not find the end of the previous iu block');
  text = text.slice(0, start) + text.slice(end);
}

const anchor = '    ["empty", []],';
if (!text.includes(anchor)) {
  throw new Error(`anchor ${JSON.stringify(anchor)} not found in ${file}`);
}
text = text.replace(anchor, `${BLOCK}${anchor}`);

writeFileSync(file, text);
console.log(
  `  iu variant written to ${file} (${fragments.length} fragments${AUDIO_ONLY ? ', audio only' : ''})`,
);
