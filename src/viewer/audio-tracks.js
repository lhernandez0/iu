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
 * It does not decode anything. Remuxing hands the element the same codec it already
 * refused, so a file whose audio the browser cannot decode plays **silence** with no
 * `MediaError` to catch — which is why `listAudioTracks` reports `playable` per track
 * and the viewer says so in words rather than letting a learner find out by ear.
 */

import {
  Input,
  Output,
  Conversion,
  BlobSource,
  MATROSKA,
  MP4,
  CmafOutputFormat,
  StreamTarget,
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
 * Play the chosen audio track by STREAMING a rebuild into the media element.
 *
 * ## Why this exists rather than buffering
 *
 * Collecting the whole rebuilt file and then playing it peaks near twice the file size
 * in memory and cannot start until the entire film has been copied. Measured: about
 * 6 ms per MB, so a 2 GB film is ~12 seconds of waiting and ~2 GB of RAM. Fine for a
 * 30 MB test file, unusable for the thing a learner actually opens.
 *
 * This feeds the element as the media is produced, so playback begins after the first
 * fragment. It is what every browser-based player does, because the browser will not
 * select audio tracks itself.
 *
 * ## The shape of it, and the two ways it is easy to get wrong
 *
 * Media Source Extensions wants an INITIALISATION segment before any media, then
 * fragments to append. So:
 *
 *   - `StreamTarget` hands us bytes as they are produced. **Not `chunked: true`** —
 *     that option accumulates up to 16 MiB before writing, which is the opposite of
 *     what is wanted here and turns a stream back into a buffer.
 *   - `CmafOutputFormat` produces exactly the init-plus-fragments pair, via
 *     `initTarget`, which is why it is used rather than plain MP4.
 *   - Initialisation and media are appended through ONE ordered queue. MSE rejects
 *     media appended before the init segment, and a single queue makes that impossible
 *     by construction rather than by remembering to check — mediabunny writes the init
 *     segment first, so it is naturally at the head.
 *
 * ## The contract, which is the part a caller must get right
 *
 * This does NOT wait for the element to attach. Waiting would deadlock: `sourceopen`
 * only fires once a `MediaSource` is attached to an element, and the caller cannot
 * attach it until this function has returned the URL. So production starts here, the
 * URL comes back immediately, and the queue drains whenever the element is ready.
 *
 * @param {File|Blob} file
 * @param {number} index Which track to KEEP.
 * @param {{onProgress?: (fraction: number) => void}} [options]
 * @returns {Promise<{url: string, done: Promise<void>, revoke: () => void}>}
 */
export async function streamTrack(file, index, options = {}) {
  const input = new Input({ source: new BlobSource(file), formats: INPUT_FORMATS });

  const videoTracks = await input.getVideoTracks();
  const audioTracks = await input.getAudioTracks();
  if (!videoTracks.length) throw new Error('This file has no video track.');
  if (!audioTracks[index]) throw new Error('That audio track is not in this file.');

  // The mime type is built from the tracks themselves, so the SourceBuffer is told the
  // truth about the codecs instead of us guessing. A wrong string here fails at
  // `addSourceBuffer` with a bare `NotSupportedError`.
  const videoCodec = await videoTracks[0].getCodecParameterString();
  const audioCodec = await audioTracks[index].getCodecParameterString();
  const mime = `video/mp4; codecs="${videoCodec},${audioCodec}"`;

  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);

  /**
   * One ordered queue for init and media alike, each chunk tagged.
   *
   * The tag exists so the ONE rule MSE imposes can be enforced here rather than
   * remembered: media may not be appended before the initialisation segment. A single
   * queue makes the ORDER right; the tag makes it checkable.
   *
   * @type {Array<{bytes: Uint8Array, init: boolean}>}
   */
  const queue = [];
  let sourceBuffer = null;
  let produced = false;
  /** @type {unknown} */
  let failure = null;
  /** Whether an initialisation chunk has been APPENDED. Media waits until it has. */
  let sawInit = false;

  /**
   * Whether production ever DELIVERED an init chunk.
   *
   * Deliberately separate from `sawInit`. This is the production-side fact and the only
   * one `done` can honestly check: if the element has not attached yet, nothing has
   * been appended and `sawInit` is false while the stream is perfectly healthy. The
   * first version of this check conflated the two and declared a working stream broken,
   * because in testing production often finishes before the element attaches.
   */
  let producedInit = false;

  /**
   * Set when chunks are arriving but nothing can be appended.
   *
   * The `sawInit` gate below is an assumption about library internals — that init is
   * always written first. If that ever stopped being true the gate would hold every
   * chunk forever, `done` would resolve cleanly, and the result would be a black
   * element with a healthy-looking UI. This is what turns that invisible hang into a
   * reported error instead.
   *
   * @type {unknown}
   */
  let stalled = null;

  const pump = () => {
    if (!sourceBuffer || sourceBuffer.updating || !queue.length) {
      // Nothing left to do. `endOfStream` is only valid once production has stopped and
      // the buffer has drained, or it throws `InvalidStateError`.
      if (produced && sourceBuffer && !sourceBuffer.updating && !queue.length) {
        try {
          if (mediaSource.readyState === 'open') mediaSource.endOfStream();
        } catch {
          // Already ended, or the element detached. Not worth surfacing.
        }
      }
      return;
    }
    const head = queue[0];
    // The rule, enforced instead of assumed: nothing may be appended until the
    // initialisation segment has been. mediabunny writes init first, so in practice
    // this never blocks — but if it ever does, the chunk count says so rather than
    // waiting forever in silence.
    if (!head.init && !sawInit) {
      if (queue.length > 1) {
        stalled = new Error('The stream produced media before its initialisation segment.');
      }
      return;
    }

    try {
      sourceBuffer.appendBuffer(head.bytes);
      if (head.init) sawInit = true;
      queue.shift();
    } catch (error) {
      // A full buffer is not a failure: the element has not played far enough to make
      // room. Leave the chunk queued and retry when `updateend` next fires.
      if (error?.name === 'QuotaExceededError') {
        setTimeout(pump, 100);
        return;
      }
      failure = error;
    }
  };

  const onChunk = (bytes, init) => {
    queue.push({ bytes, init });
    pump();
  };

  const initTarget = new StreamTarget(
    new WritableStream({
      write(chunk) {
        producedInit = true;
        onChunk(chunk.data, true);
      },
    }),
  );

  // Deliberately NOT `chunked`: chunking accumulates 16 MiB before it writes anything,
  // which would mean no playback until a large fraction of the film was copied.
  const mediaTarget = new StreamTarget(
    new WritableStream({
      write(chunk) {
        onChunk(chunk.data, false);
      },
    }),
  );

  mediaSource.addEventListener(
    'sourceopen',
    () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
        // `segments` is the correct mode for a fragmented stream and the default; set
        // explicitly so a change of default cannot silently alter behaviour.
        sourceBuffer.mode = 'segments';
        sourceBuffer.addEventListener('updateend', () => pump());
        pump();
      } catch (error) {
        // Thrown here for a codec the browser will not take — the one case where the
        // failure is worth naming, because the alternative is silence.
        failure = error;
      }
    },
    { once: true },
  );

  // Production starts now and is NOT awaited before returning: see the contract above.
  const done = (async () => {
    const output = new Output({
      format: new CmafOutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      target: mediaTarget,
      initTarget,
    });

    const conversion = await Conversion.init({
      input,
      output,
      audio: (track, n) => (n - 1 === index ? {} : { discard: true }),
    });
    // Progress is reported from the conversion, which is what knows how far along the
    // input is. The SourceBuffer's own buffered range says how much has been APPENDED,
    // which is the same thing only when nothing is queued.
    conversion.onProgress = (progress) => options.onProgress?.(Math.min(1, progress));
    await conversion.execute();
    produced = true;
    pump();
    // Both are checked here, and `stalled` is checked as well as `failure`: a stream
    // that never drained is a failure whether or not anything threw.
    if (failure) throw failure;
    if (stalled) throw stalled;
    // The production-side fact, not `sawInit`: the element may not have attached yet.
    if (!producedInit) throw new Error('The stream produced no initialisation segment.');
  })();

  return {
    url,
    done,
    revoke: () => {
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch {
        // Already ended, or never opened.
      }
      URL.revokeObjectURL(url);
    },
  };
}

