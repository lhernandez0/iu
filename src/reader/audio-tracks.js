/**
 * Choosing which audio track plays.
 *
 * ## Why this module exists at all
 *
 * `HTMLMediaElement.audioTracks` is the standard way to do this, and it is **not
 * available in any released browser**. Measured 2026-10-09: Chrome 148 and Firefox 155
 * both play a file with two audio tracks and neither exposes `audioTracks`,
 * `videoTracks`, `webkitAudioTracks` or `setAudioTrack`.
 *
 * It IS implemented in Blink, behind `--enable-blink-features=AudioVideoTracks` or the
 * user-facing `--enable-experimental-web-platform-features`. With either flag it works
 * correctly — verified by frequency analysis, not by reading `.enabled` back
 * (`probe-audio-hear-switch.mjs`: switching a 440/880 Hz file really moves the tone).
 * Chromium held it back because switching froze playback; that was fixed in **M138**,
 * June 2025, and the reporter confirmed it on M139.
 *
 * So there are two paths and this module owns both:
 *
 *   1. **The API, when the browser has it.** Preferred: the browser demuxes, decodes
 *      and switches, which means it handles every codec it can PLAY — including AC-3
 *      and DTS, which we cannot decode ourselves at any price we would pay.
 *   2. **Remuxing, when it does not.** Ask for a copy of the file containing only the
 *      chosen track, and hand the element that. Costs real work per switch and only
 *      covers codecs the element can already play, but it needs no flag and no
 *      permission.
 *
 * ## What this does NOT do
 *
 * It does not decode anything. `decode-eac3` and friends exist and are LGPL, and are
 * deliberately not used here: remuxing a codec the browser cannot decode produces a
 * file that plays **silence**. That is a worse failure than an error, because there is
 * nothing to catch — so `canPlayCodec` is checked first and the caller is told.
 */

import {
  Input,
  Output,
  Conversion,
  BufferTarget,
  BlobSource,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
} from '../vendor/mediabunny.js';

/**
 * Audio codecs a browser can be expected to decode.
 *
 * Only used to WARN. A codec absent from this list is not refused — `canPlayType` has
 * the final say, because a browser may support more than this list knows (and Chrome on
 * Windows ships AC-3 where Linux Chromium does not). The list exists so the common
 * failure can be named in advance rather than discovered as silence.
 */
const WIDELY_PLAYABLE = new Set(['aac', 'mp3', 'opus', 'flac', 'vorbis', 'pcm-s16', 'pcm-s24', 'pcm-f32']);

/** Containers the remuxer reads. MP4 is worth having: WEB-DL rips are often MP4. */
export const INPUT_FORMATS = [MATROSKA, MP4];

/**
 * Whether the browser gives us the API, which is the only route that covers every
 * codec it can play.
 *
 * Feature-detected on the prototype rather than an instance, because the question is
 * whether the CAPABILITY exists and an element may not be loaded yet.
 */
export function audioTracksSupported() {
  return 'audioTracks' in HTMLMediaElement.prototype;
}

/**
 * The audio tracks a file declares, in file order.
 *
 * Names come from the file's own metadata and never from the filename: a release name
 * says nothing about which stream is which, and inventing a label is how a selector
 * offers a choice it cannot honour.
 *
 * @param {File|Blob} file
 * @returns {Promise<Array<{index: number, number: number, codec: string,
 *   language: string|null, channels: number|null, label: string,
 *   playable: boolean}>>}
 */
export async function listAudioTracks(file) {
  const input = new Input({ source: new BlobSource(file), formats: INPUT_FORMATS });
  const tracks = await input.getAudioTracks();

  return tracks.map((track, index) => {
    const codec = track.codec ?? 'unknown';
    const language = track.languageCode && track.languageCode !== 'und' ? track.languageCode : null;
    // The file's own label first, then the language, then the position. Most Matroska
    // files carry neither a title nor a language, and a list of identical "Track"
    // entries is worse than useless — the index is always there, so there is always
    // something to say.
    const name = track.name || language || '';
    return {
      index,
      number: track.number,
      codec,
      language,
      channels: track.numberOfChannels ?? null,
      label: name ? `${index + 1}. ${name}` : `Track ${index + 1}`,
      playable: WIDELY_PLAYABLE.has(codec),
    };
  });
}

/**
 * A copy of the file containing only the chosen audio track.
 *
 * ## The one thing that is easy to get wrong
 *
 * The per-track callback returns `undefined` to mean **"no opinion — use the
 * defaults"**, which KEEPS the track. Writing `n === 2 ? {} : undefined` therefore
 * keeps everything and silently produces a file still playing track 1. `{ discard:
 * true }` is the only thing that removes a track, and getting this wrong looks exactly
 * like success until you listen.
 *
 * ## Cost, measured
 *
 * `BufferTarget` holds the whole output in memory, so this peaks at roughly twice the
 * file size and returns a Blob. Measured 2026-10-09 on this machine: 20 ms for a
 * 120 KB file, 175 ms for a 30 MB one — about 6 ms per MB. So a 2 GB film is ~12
 * seconds and a 2 GB memory peak, which is why the caller must show progress and why
 * streaming into MSE is the next step if this is kept.
 *
 * @param {File|Blob} file
 * @param {number} index Which track to KEEP.
 * @param {{signal?: AbortSignal, onProgress?: (fraction: number) => void}} [options]
 * @returns {Promise<Blob>}
 */
export async function remuxToTrack(file, index, options = {}) {
  const input = new Input({ source: new BlobSource(file), formats: INPUT_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });

  // `n` is 1-based; `index` is not.
  const conversion = await Conversion.init({
    input,
    output,
    audio: (track, n) => (n - 1 === index ? {} : { discard: true }),
  });

  if (options.onProgress) {
    conversion.onProgress = (progress) => options.onProgress(progress);
  }

  if (options.signal) options.signal.addEventListener('abort', () => void conversion.cancel(), { once: true });

  await conversion.execute();

  if (!target.buffer) throw new Error('The remux produced no data.');
  return new Blob([target.buffer], { type: 'video/mp4' });
}
