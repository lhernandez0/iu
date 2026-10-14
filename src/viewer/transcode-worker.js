/**
 * The transcode, off the main thread.
 *
 * ## Why this is a worker
 *
 * **Measured: running it on the main thread blocked the page hard enough that Chrome
 * offered to kill the tab.** The 100 ms heartbeat fell from about 10 ticks a second to
 * **0**, and heap climbed toward 400 MB. The same file run in a Worker left the page at
 * its normal 10 ticks a second. So the main thread never runs mediabunny's conversion;
 * it appends bytes.
 *
 * ## What runs here, and what does not
 *
 * Mediabunny reads the file, **copies the video untouched**, decodes the chosen audio
 * track with the registered coders, re-encodes it to AAC, and writes a fragmented MP4
 * back out in chunks. Only the audio is touched; only the chosen track; only when the
 * browser cannot play that codec. See `coders.js` for why the coders are lazily
 * registered.
 *
 * **The coder packages spawn their own worker inside this one.** That nesting was
 * measured to work under the extension's CSP, so it is deliberate rather than accidental.
 * A failure inside that inner worker does not reach this file's error handling, which is
 * why the inner worker's errors are surfaced rather than assumed away.
 *
 * ## The protocol
 *
 * The main thread sends `{ type: 'convert', id, file, trackIndex }` to open a file and
 * `{ type: 'seek', id, seconds }` to move the produced window. A new `convert` replaces
 * the previous file.
 *
 * This worker replies with `{ id, type: 'mime', mime, duration }` once before any
 * fragment, then `{ id, type: 'init' | 'media', bytes, offset }` per chunk, then
 * `{ id, type: 'progress', fraction }` throttled to whole percent, and finally
 * `{ id, type: 'done' }` or `{ id, type: 'error', message }`.
 */

import {
  Input,
  Output,
  Conversion,
  BlobSource,
  ALL_FORMATS,
  Mp4OutputFormat,
  StreamTarget,
  EncodedPacketSink,
} from '../vendor/mediabunny.js';
import { registerCoders } from './coders.js';

/** AAC bitrate, in bits per second. Generous for speech, small against the video. */
const AUDIO_BITRATE = 192_000;

/**
 * Log one step under the extension's diagnostic prefix.
 *
 * A worker's own console is easy to lose, so the bridge forwards worker errors to the
 * main console. This prefix is what makes them findable in either.
 *
 * @param {string} step
 * @param {Record<string, unknown>} [fields]
 */
function trace(step, fields = {}) {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`);
  console.log(`[iu] transcode step=${step}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

/** The conversion currently running, so a seek can cancel it. @type {any} */
let current = null;
/** The `Input` for the open file, reused across seeks rather than re-opened. */
let currentInput = null;
/** The chosen audio track index, so a seek re-runs the same track. */
let currentTrack = 0;

/** Join two `Uint8Array`s. */
function concatBytes(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

/** Read a big-endian `uint32`. */
function readUint32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** Read a big-endian `uint64`, clamped to a safe integer. */
function readUint64(bytes, at) {
  const high = readUint32(bytes, at);
  const low = readUint32(bytes, at + 4);
  if (high > 0x001fffff) return Number.MAX_SAFE_INTEGER;
  return high * 0x100000000 + low;
}

/**
 * Split a stream of MP4 bytes into one initialisation segment and the media after it.
 *
 * **`Mp4OutputFormat` writes everything through one target**, in order: `ftyp`, `moov`,
 * then `moof`/`mdat` fragments. A single write can contain the end of one box and the
 * start of the next, so the init-to-media boundary is inside a write. MSE requires the
 * initialisation segment to be appended before any media, so the boundary is found by
 * reading box headers rather than guessed.
 *
 * Only the top level is parsed, which is all the boundary needs: the init boxes are
 * `ftyp` and `moov`, and media is everything from the first `moof` or `mdat` onward.
 */
class Segmenter {
  /** @param {(bytes: Uint8Array, init: boolean) => void} emit */
  constructor(emit) {
    this.emit = emit;
    /** Bytes received but not yet classified. @private */
    this.buffer = new Uint8Array(0);
    /** Once true, everything is media. @private */
    this.inMedia = false;
  }

  /** @param {Uint8Array} bytes */
  push(bytes) {
    this.buffer = concatBytes(this.buffer, bytes);
    for (;;) {
      if (this.buffer.length < 8) return;
      const size = readUint32(this.buffer, 0);
      const type = String.fromCharCode(this.buffer[4], this.buffer[5], this.buffer[6], this.buffer[7]);
      // A size of 0 means "to the end of file", which cannot happen here; 1 means a
      // 64-bit size follows.
      const boxSize = size === 1 ? readUint64(this.buffer, 8) : size;
      if (boxSize < 8 || this.buffer.length < boxSize) return;
      const box = this.buffer.slice(0, boxSize);
      this.buffer = this.buffer.slice(boxSize);
      if (!this.inMedia && (type === 'moof' || type === 'mdat')) this.inMedia = true;
      this.emit(box, !this.inMedia);
    }
  }
}

/**
 * The keyframe at or before a time, in seconds.
 *
 * **A pass can only begin where the video can be decoded from nothing**, which is a key
 * packet, so a seek re-runs the conversion from here rather than from the requested time.
 * The gap is under a second of extra audio to decode.
 *
 * @param {any} input
 * @param {number} seconds
 * @returns {Promise<number>}
 */
async function keyframeAtOrBefore(input, seconds) {
  const video = await input.getPrimaryVideoTrack();
  if (!video) return Math.max(0, seconds);
  try {
    const packet = await new EncodedPacketSink(video).getKeyPacket(seconds);
    return packet ? packet.timestamp : 0;
  } catch {
    return Math.max(0, seconds);
  }
}

/**
 * Convert the file from `start` seconds, posting fragments as they are produced.
 *
 * @param {number} id The pass id.
 * @param {number} start Where to begin reading, in source seconds.
 * @param {number} offset Where the bridge should place this pass, in source seconds.
 *   Equal to `start` for a whole-file pass; for a seek it is the requested time while
 *   `start` is the keyframe before it.
 */
async function runPass(id, start, offset) {
  const input = currentInput;
  const duration = await input.computeDuration();

  // The mime string must name the OUTPUT's codecs. The video is copied, so its codec
  // string comes from the input track, and asking the track rather than hardcoding is
  // what keeps a 1080p High-profile film from being announced as Baseline, which the
  // browser then refuses. A file with no video gets an audio-only type.
  const video = await input.getPrimaryVideoTrack();
  const videoCodec = video ? await video.getCodecParameterString() : null;
  self.postMessage({
    id,
    type: 'mime',
    mime: videoCodec ? `video/mp4; codecs="${videoCodec},mp4a.40.2"` : 'audio/mp4; codecs="mp4a.40.2"',
    duration,
  });

  // The byte stream is split into init and media as it arrives, and each chunk carries
  // the offset this pass belongs at, because a pass numbers its own output from zero.
  const segmenter = new Segmenter((bytes, init) => {
    self.postMessage({ id, type: init ? 'init' : 'media', bytes, offset }, [bytes.buffer]);
  });
  const target = new StreamTarget(
    new WritableStream({
      write(chunk) {
        segmenter.push(chunk.data);
      },
    }),
  );

  const output = new Output({
    // **Plain fragmented MP4, NOT `CmafOutputFormat`.** CMAF emits fragments on time but
    // writes the whole file as one chunk at the end, so nothing plays until the
    // conversion finishes. `Mp4OutputFormat` writes each fragment as it is made.
    format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
    target,
  });

  const tracks = await input.getAudioTracks();
  if (!tracks.length) throw new Error('This file has no audio track.');

  const chosenNumber = (tracks[currentTrack] ?? tracks[0]).number;

  const conversion = await Conversion.init({
    input,
    output,
    // The video is copied, never re-encoded: no picture is touched, and it is the
    // expensive half by byte count.
    video: {},
    // **Only the chosen audio track is decoded.** `Conversion` takes a per-track
    // callback, so every other audio track is discarded rather than decoded: a file with
    // two AC-3 tracks must not pay for both, and the selector's choice must be the one
    // on screen.
    audio: (track) => (track.number === chosenNumber ? { codec: 'aac', bitrate: AUDIO_BITRATE } : { discard: true }),
    trim: start > 0 ? { start } : undefined,
  });

  // Progress is throttled to whole percent: the conversion reports on every internal step,
  // which on a long film is hundreds of events a second, and logging each one floods the
  // console and costs real time on the path that is already the bottleneck.
  let lastPercent = -1;
  conversion.onProgress = (progress) => {
    const percent = Math.round(progress * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    self.postMessage({ id, type: 'progress', fraction: percent / 100 });
  };

  current = conversion;
  try {
    await conversion.execute();
  } finally {
    if (current === conversion) current = null;
  }
  self.postMessage({ id, type: 'done' });
}

/** Cancel the running pass, if any, and wait for it to actually stop. */
async function cancelCurrent() {
  const running = current;
  current = null;
  if (!running) return;
  try {
    await running.cancel();
  } catch {
    // Already finished; the conversion it was cancelling is done.
  }
}

/**
 * Open a file and start converting it.
 *
 * @param {number} id
 * @param {File|Blob} file
 * @param {number} [trackIndex]
 */
async function startConvert(id, file, trackIndex = 0) {
  await cancelCurrent();
  currentTrack = trackIndex;
  currentInput = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  await registerCoders();
  // A whole-file pass starts at zero and is placed at zero, so the video is copied from
  // its own first keyframe with no trim.
  await runPass(id, 0, 0);
}

/**
 * Move the produced window to a new source time.
 *
 * **A seek cannot be answered by waiting.** A pass is a single forward run, so a region it
 * has not reached would need everything in between decoded: measured at 20 s for a
 * 10-minute file, and scaling with the jump, so tens of minutes for a film. Instead the
 * running pass is cancelled and a new one begins at the keyframe before the target, which
 * the bridge places at the REQUESTED time with `timestampOffset`. That is the DASH/HLS
 * segment model.
 *
 * @param {number} id The new pass id.
 * @param {number} seconds Where the viewer asked to be.
 */
async function seekTo(id, seconds) {
  if (!currentInput) return;
  const start = await keyframeAtOrBefore(currentInput, seconds);
  await cancelCurrent();
  trace('seek', { requested: Number(seconds.toFixed(1)), keyframe: Number(start.toFixed(1)) });
  await runPass(id, start, seconds);
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'convert') {
    startConvert(message.id, message.file, message.trackIndex).catch((error) => {
      self.postMessage({ id: message.id, type: 'error', message: String(error?.message ?? error) });
    });
  } else if (message.type === 'seek') {
    seekTo(message.id, message.seconds).catch((error) => {
      self.postMessage({ id: message.id, type: 'error', message: String(error?.message ?? error) });
    });
  }
});

// A rejected promise anywhere in this worker would otherwise vanish, and the symptom is a
// film with no sound rather than an error. Surface it.
self.addEventListener('unhandledrejection', (event) => {
  trace('unhandled-rejection', { reason: String(event.reason?.message ?? event.reason) });
});
