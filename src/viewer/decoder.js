/**
 * Playing audio the browser cannot decode.
 *
 * ## The problem
 *
 * Measured: a file whose only audio track is AC-3 or E-AC-3 plays its picture and
 * emits **silence**, with no `MediaError` to catch. `canPlayType` is not a verdict
 * either: it reports `"probably"` for HEVC video and the element then fails with
 * `error: 4`. So neither the container nor the codec string can be trusted.
 *
 * This does the two things the browser will not:
 *
 *   1. **Decode** the audio, with the bundled FFmpeg build (`libav.js`).
 *   2. **Play** the decoded samples, through Web Audio.
 *
 * The video keeps playing with its own sound muted, and this produces the sound.
 * The two are kept in step by one clock, the element's `currentTime`.
 *
 * ## Why decoding happens off the main thread
 *
 * Decoding a film is seconds of solid CPU, and on the main thread that is a frozen
 * viewer, which is the opposite of the point. Measured: under the extension's own
 * origin the libav.js loader constructs its Worker with no flag, so this runs off
 * the main thread for free.
 *
 * ## Why the audio is decoded in windows rather than all at once
 *
 * An hour of stereo at 48 kHz is about 1.4 GB as Float32, so decoding the whole file
 * is not an option. This keeps a couple of seconds decoded ahead of the playhead and
 * refills as playback advances, so memory is bounded by the window, not the film.
 *
 * ## Why the decoder is loaded lazily
 *
 * It is 6 MB of WebAssembly. It is imported only after the browser has already
 * failed to play a track, so a file the browser handles never reads it. LGPL-2.1;
 * see `THIRD-PARTY.md`.
 */

/** Where the built decoder lives, relative to this file. Gitignored, shipped in the ZIP. */
const DECODER_URL = '../vendor/libav.js';

/**
 * Seconds of audio to keep decoded ahead of the playhead.
 *
 * A balance, not a tuned constant: too small and a slow decode starves playback
 * into clicks, too large and a seek discards work. Two seconds is roughly what
 * playback needs to survive a scheduling hiccup.
 */
const DECODE_AHEAD_SECONDS = 2;

/** How often to top up the buffer while playing, in milliseconds. */
const REFILL_INTERVAL_MS = 200;

/**
 * `ff_read_frame_multi` returns this when it hit the output limit rather than the
 * end of the stream. Measured, and it is `-EAGAIN` as libav.js reports it.
 */
const EAGAIN = -11;

/** `av_seek_frame` flag: land on the keyframe at or before the timestamp. */
const AVSEEK_FLAG_BACKWARD = 4;

/** Microseconds per second, the unit `av_seek_frame` wants. */
const MICROSECONDS = 1_000_000;

/** @type {Promise<any>|null} */
let libraryPromise = null;

/**
 * Import the decoder once per page.
 *
 * The dynamic import is what keeps 6 MB out of the page until it is needed, and
 * caching the promise means two callers racing to load it share one load.
 *
 * @returns {Promise<any>}
 */
function loadLibrary() {
  if (!libraryPromise) {
    libraryPromise = import(DECODER_URL).catch((error) => {
      // Cleared so a later attempt can retry: a transient failure should not poison
      // every future attempt for the life of the page.
      libraryPromise = null;
      throw error;
    });
  }
  return libraryPromise;
}

/**
 * Whether the decoder can decode a given FFmpeg codec id.
 *
 * Asked of the binary itself, via `avcodec_find_decoder`, never of a hardcoded
 * list. A list here would be a second source of truth that drifts from what the
 * binary contains, and the reason this custom build exists is precisely that the
 * published variants' contents did not match what was claimed: they list `ac3` in
 * their strings and cannot decode it.
 *
 * @param {number} codecId An FFmpeg `AVCodecID`.
 * @returns {Promise<boolean>}
 */
export async function canDecode(codecId) {
  const { default: LibAV } = await loadLibrary();
  const libav = await LibAV.LibAV();
  const found = await libav.avcodec_find_decoder(codecId);
  return Boolean(found);
}

/**
 * Decodes one audio track of a file and plays it.
 *
 * The viewer owns the `AudioContext` and drives this from the events it already
 * listens to: `start`, `play`, `pause`, `seek`, `setVolume`, `dispose`.
 */
export class TrackDecoder {
  /**
   * @param {File|Blob} file
   * @param {number} trackIndex Which audio track, among the audio tracks, in file order.
   */
  constructor(file, trackIndex) {
    /** @private */ this.file = file;
    /** @private */ this.trackIndex = trackIndex;
    /** @private */ this.libav = null;
    /** @private */ this.context = null;
    /** @private */ this.nodes = [];
    /** @private */ this.timer = null;
    /** @private */ this.disposed = false;
    /**
     * Whether playback should be producing sound. Guards `fill`, so a paused decoder
     * that is merely repositioned by a seek does not schedule audio that would play
     * over a paused picture.
     * @private
     */
    this.playing = false;
    /** @private */ this.gain = null;
    /**
     * When the NEXT buffer should start, on the AudioContext clock. Zero means
     * "nothing scheduled yet", which is what a seek resets it to.
     * @private
     */
    this.nextStart = 0;
    /**
     * The sync anchor: a media time and the AudioContext time at which that media
     * time plays. Everything after it is measured from here, which is how the viewer
     * learns where the AUDIO has actually reached rather than assuming it tracks the
     * picture. Re-set from the first buffer after each seek.
     *
     * @type {{media: number, context: number}|null}
     * @private
     */
    this.anchor = null;
  }

  /**
   * The media time currently sounding, in seconds.
   *
   * This is the audio's own position, derived from the anchor and the audio clock,
   * not a copy of the element's `currentTime`. Reading it lets the viewer detect
   * drift and correct it, which is the whole point of decoding separately: two
   * clocks, one of which can be measured.
   *
   * @returns {number|null} Null before anything has been scheduled.
   */
  get position() {
    if (!this.anchor) return null;
    return this.anchor.media + (this.context.currentTime - this.anchor.context);
  }

  /**
   * Prepare the track and decode from `seconds`.
   *
   * @param {number} seconds
   * @param {AudioContext} context Shared with the viewer, so there is one audio
   *   device rather than one per decoder.
   */
  async start(seconds, context) {
    const { default: LibAV } = await loadLibrary();
    this.context = context;
    this.libav = await LibAV.LibAV();

    const bytes = new Uint8Array(await this.file.arrayBuffer());
    await this.libav.writeFile('decoding.bin', bytes);
    const [format, streams] = await this.libav.ff_init_demuxer_file('decoding.bin');
    this.format = format;
    this.streams = streams;

    const stream = streams.filter((entry) => entry.codec_type === 1)[this.trackIndex];
    if (!stream) throw new Error('That audio track is not in this file.');
    this.stream = stream;
    // The key packets come back under. It is the stream's index in the FILE, which
    // is not its position among the audio streams when the file interleaves video.
    this.streamIndex = stream.index;

    const [, decoder, packets, frame] = await this.libav.ff_init_decoder(
      stream.codec_id,
      stream.codecpar,
    );
    this.decoder = decoder;
    this.packets = packets;
    this.frame = frame;

    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);

    // Positioned but NOT scheduled: `start` runs while the element may still be
    // paused, and scheduling here would play decoded audio over a paused picture,
    // because Web Audio knows nothing about the video element. Playback begins in
    // `play`, which the viewer calls from the element's own `play`.
    await this.seek(seconds);
  }

  /**
   * Move the decode position, discarding whatever was scheduled.
   *
   * Every scheduled buffer belongs to a position the playhead is leaving, so they
   * are stopped rather than left to play out; otherwise a seek is followed by a
   * moment of the old position.
   *
   * Reschedules only if playback is running, so the same call serves a mid-playback
   * seek (which must produce sound immediately) and the initial positioning (which
   * must not).
   *
   * @param {number} seconds
   */
  async seek(seconds) {
    if (this.disposed) return;
    this.stopNodes();

    // `AVSEEK_FLAG_BACKWARD`: land on the keyframe at or before the target, which is
    // where the decoder has the state to produce correct samples from. A forward
    // seek would start after the target and drop audio.
    await this.libav.av_seek_frame(
      this.format,
      -1,
      Math.floor(seconds * MICROSECONDS),
      0,
      AVSEEK_FLAG_BACKWARD,
    );
    this.nextStart = 0;
    // The old anchor describes a position the playhead has left, so it is dropped;
    // the next scheduled buffer establishes a new one.
    this.anchor = null;
    if (this.playing) await this.fill();
  }

  /** Stop every scheduled buffer and clear the refill timer. @private */
  stopNodes() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // Already finished. Nothing to undo.
      }
    }
    this.nodes = [];
  }

  /**
   * Begin or resume playback from `seconds`, which the caller takes from the element.
   *
   * The position is passed in rather than remembered, because the element is the one
   * clock and it is the authority on where playback is. Re-anchoring to it on every
   * play is what keeps the audio with the picture across a pause, which can be long
   * enough for the two to have parted.
   *
   * @param {number} seconds
   */
  async play(seconds) {
    if (this.disposed) return;
    this.playing = true;
    // Re-sought rather than resumed, because a pause may have lasted minutes and the
    // element may have moved. Stops any buffer already scheduled, so there is no
    // double audio.
    await this.seek(seconds);
    await this.fill();
    if (!this.timer) this.timer = setInterval(() => void this.fill(), REFILL_INTERVAL_MS);
  }

  /**
   * Stop producing sound.
   *
   * Stops the scheduling timer AND the buffers already handed to the audio device.
   * Only clearing the timer would leave up to two seconds of already-scheduled audio
   * playing after a pause, which reads as the pause not working.
   */
  pause() {
    this.playing = false;
    this.stopNodes();
  }

  /**
   * Decode until the window is full or the stream ends.
   *
   * Reads in bounded batches and lets `EAGAIN` (the read limit) end one call rather
   * than looping until the target is met, so a single call cannot block for long on
   * a badly interleaved file. The guard is a belt on top of that: a stream that
   * keeps returning empty batches must not spin forever.
   * @private
   */
  async fill() {
    if (this.disposed || !this.libav) return;
    // `nextStart` is 0 before anything is scheduled, so the window is measured from
    // the playhead until the first buffer exists.
    const from = this.nextStart || this.context.currentTime;
    const target = Math.max(this.context.currentTime, from) + DECODE_AHEAD_SECONDS;
    let guard = 0;

    while (!this.disposed && this.nextStart < target && guard++ < 64) {
      const [result, byStream] = await this.libav.ff_read_frame_multi(
        this.format,
        this.packets,
        { limit: 1 << 20 },
      );
      const batch = byStream[this.streamIndex];
      let produced = 0;
      if (batch?.length) {
        const frames = await this.libav.ff_decode_multi(
          this.decoder,
          this.packets,
          this.frame,
          batch,
          true,
        );
        for (const decoded of frames) this.schedule(decoded);
        produced = frames.length;
      }
      // `EAGAIN` means the read limit was hit, so another call will produce more.
      // Anything else with no packets or no frames means there is nothing left.
      if (result === EAGAIN) continue;
      if (!produced && !batch?.length) break;
    }
  }

  /**
   * Schedule one decoded frame for playback.
   *
   * Samples arrive as planar Float32, exactly what `copyToChannel` wants, so there is
   * no conversion step. Buffers are scheduled back to back from `nextStart` so they
   * play continuously, and the first one after a seek sets the sync anchor from the
   * frame's OWN timestamp, which is how the audio clock stays tied to the file rather
   * than to when decoding happened to run.
   *
   * @param {object} decoded A frame from `ff_decode_multi`, carrying `data`,
   *   `sample_rate`, `best_effort_timestamp` and the `time_base` to interpret it.
   * @private
   */
  schedule(decoded) {
    const channels = decoded.data.length;
    const length = decoded.data[0]?.length ?? 0;
    if (!length) return;

    const buffer = this.context.createBuffer(channels, length, decoded.sample_rate);
    for (let channel = 0; channel < channels; channel++) {
      buffer.copyToChannel(decoded.data[channel], channel);
    }

    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    // Never schedule in the past: after a stall the queue can fall behind the clock,
    // and a start time in the past plays immediately, which is the recovery wanted.
    this.nextStart = Math.max(this.nextStart, this.context.currentTime);
    node.start(this.nextStart);
    this.nodes.push(node);

    // The anchor, from the frame's own position in the file. `best_effort_timestamp`
    // is in units of `time_base_num / time_base_den` seconds; a frame that reports no
    // timestamp falls back to the running schedule, which is still a valid clock.
    const stamp = decoded.best_effort_timestamp;
    if (this.anchor === null) {
      const media =
        stamp != null && decoded.time_base_den
          ? (stamp * decoded.time_base_num) / decoded.time_base_den
          : this.nextStart;
      this.anchor = { media, context: this.nextStart };
    }

    this.nextStart += buffer.duration;
  }

  /**
   * Set the playback level, mirroring the element's own volume.
   *
   * @param {number} value 0..1
   * @param {boolean} muted
   */
  setVolume(value, muted) {
    if (this.gain) this.gain.gain.value = muted ? 0 : value;
  }

  /** Release everything. Not reusable after this. */
  dispose() {
    this.disposed = true;
    this.stopNodes();
    this.libav = null;
  }
}
