/**
 * Add the `iu` variant to a libav.js checkout.
 *
 *   node tools/libav/add-variant.mjs <path-to-libav.js-checkout>
 *
 * libav.js has no plugin mechanism: a new build variant is a new entry in
 * `configs/mkconfigs.js`, a 1000 line file of variant definitions. This script
 * inserts that entry, because hand-editing a file that large is the step that
 * made the first build unreproducible when the checkout was deleted with the
 * edit still inside it.
 *
 * It is idempotent. Re-running replaces the previous block instead of appending
 * a second one, so the checkout can be reused across builds.
 *
 * `tools/build-libav.mjs` calls this. There is no reason to call it directly
 * unless you are debugging the variant definition itself.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/libav/add-variant.mjs <libav.js checkout>');
  process.exit(1);
}
const file = join(src, 'configs', 'mkconfigs.js');

/**
 * The variant, as it appears in `configs/mkconfigs.js`.
 *
 * Every name here is a libav.js "fragment" (`configs/fragments/`) that pulls in
 * an FFmpeg configure flag. The split below is by *why we need it*, not by
 * library, because the reason is what has to survive the next edit.
 *
 * `avfcbridge` is named for a build reason: `avframe` and `avfcbridge` both
 * declare `ff_copyout_frame_data_packed`, and linking both fails. `avfcbridge`
 * provides it and `avframe` is not needed, so only one is present.
 */
const BLOCK = `    // IU: the variant this project builds. Everything a media player needs that a
    // browser does not already decode: the containers it will not open, the Dolby
    // audio codecs, HEVC, and the legacy formats a film collection accumulates.
    //
    // DTS is deliberately absent. libav.js has no dca/dts fragment, and the
    // non-GPL DTS decoder situation is a separate project. Out of scope, said
    // out loud here so nobody discovers it from a bug report.
    ["iu", [
        "avformat", "avcodec", "avfilter", "swresample", "swscale",
        "avfcbridge",

        // Containers a browser cannot open.
        "demuxer-mpegts", "demuxer-avi", "demuxer-asf", "demuxer-flv",
        "demuxer-matroska", "demuxer-mp4", "demuxer-mpeg", "demuxer-ogg",
        "demuxer-wav", "demuxer-flac",

        // Audio the browser cannot decode.
        //
        // AC-3 and E-AC-3 are SEPARATE decoders in FFmpeg: "ac3" is Dolby Digital,
        // "eac3" is Dolby Digital Plus, and enabling one does NOT give you the
        // other. A build with only ac3 demuxes an eac3 file, reports both streams,
        // and then fails at ff_init_decoder with "Codec not found", because the
        // decoder is genuinely not in the binary. Cost a debugging cycle; written
        // down so it costs one and not two.
        "decoder-ac3", "decoder-eac3", "parser-ac3",
        "decoder-aac", "parser-aac",
        "decoder-mp3", "parser-mpegaudio",
        "decoder-opus", "parser-opus",
        "decoder-flac", "parser-flac",
        "decoder-vorbis", "parser-vorbis",
        "decoder-wmav1", "decoder-wmav2", "decoder-wmapro", "decoder-wmalossless",
        "decoder-cook", "decoder-sipr", "decoder-ra_144", "decoder-ra_288",
        "decoder-dvaudio", "decoder-wavpack", "decoder-alac",
        "decoder-pcm_s16le", "decoder-pcm_s24le", "decoder-pcm_s32le",
        "decoder-pcm_f32le", "codec-pcm_f32le", "decoder-pcm_s16be",
        "decoder-pcm_s24be", "decoder-pcm_f64le", "decoder-pcm_u8",
        "decoder-pcm_s8",

        // Video the browser cannot decode. HEVC is the one that matters most, the
        // common codec in high definition releases that Chrome will not decode.
        "decoder-hevc", "parser-hevc",
        "decoder-h264", "parser-h264",
        "decoder-mpeg1video", "decoder-mpeg2video", "parser-mpegvideo",
        "decoder-mpeg4", "parser-mpeg4video",
        "decoder-msmpeg4v1", "decoder-msmpeg4v2", "decoder-msmpeg4v3",
        "decoder-wmv1", "decoder-wmv2", "decoder-wmv3",
        "decoder-vc1", "decoder-vp8", "parser-vp8", "decoder-vp9", "parser-vp9",
        "decoder-theora", "decoder-dvvideo", "decoder-prores",
        "decoder-indeo2", "decoder-indeo3", "decoder-indeo4", "decoder-indeo5",

        // Remux and convert support: read one container, write another.
        "muxer-mp4", "muxer-matroska", "muxer-webm", "muxer-wav", "muxer-ogg",
        "audio-filters", "video-filters",
        "avbsf", "bsf-extract_extradata",
        "bsf-h264_mp4toannexb", "bsf-hevc_mp4toannexb",
        "bsf-vp9_metadata", "bsf-av1_metadata"
    ], {avf: true}],

`;

const MARKER = '    // IU: the variant this project builds.';

let text = readFileSync(file, 'utf8');

// Remove a previous block first. Everything from our marker up to the next
// variant definition (`["empty", []]` is the one that follows in upstream) is
// ours to replace, which is what keeps this idempotent.
const start = text.indexOf(MARKER);
if (start !== -1) {
  const end = text.indexOf('    ["empty", []],', start);
  if (end === -1) throw new Error('could not find the end of the previous iu block');
  text = text.slice(0, start) + text.slice(end);
}

// Insert before the neighbouring variant so the diff stays readable.
const anchor = '    ["empty", []],';
if (!text.includes(anchor)) {
  throw new Error(`anchor ${JSON.stringify(anchor)} not found in ${file}`);
}
text = text.replace(anchor, `${BLOCK}${anchor}`);

writeFileSync(file, text);
console.log(`  iu variant written to ${file}`);
