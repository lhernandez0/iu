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
 * Log one step of the decode path, under the extension's diagnostic prefix.
 *
 * Duplicated from `diagnostics.js` rather than imported, deliberately: this module is
 * the one that FAILS when the decoder is missing or broken, and importing a sibling
 * through the same module graph it is diagnosing would be the wrong dependency. A
 * `console.log` with the same prefix costs nothing and always works.
 *
 * @param {string} step
 * @param {Record<string, unknown>} [fields]
 */
function trace(step, fields = {}) {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`);
  console.log(`[iu] decoder step=${step}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

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
    trace('import-start', { url: DECODER_URL });
    libraryPromise = import(DECODER_URL)
      .then((module) => {
        trace('import-ok', { hasLibAV: typeof module?.default?.LibAV });
        return module;
      })
      .catch((error) => {
        // Cleared so a later attempt can retry: a transient failure should not poison
        // every future attempt for the life of the page.
        libraryPromise = null;
        trace('import-FAILED', { error: String(error?.message ?? error) });
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
    /**
     * The media time the last seek ASKED for.
     *
     * Frames before this are dropped by `schedule`, because a backward seek lands on
     * an earlier keyframe and the decoder produces the audio in between. Kept as a
     * field rather than a parameter because `schedule` is called from `fill`, which
     * does not know what was requested.
     *
     * @type {number|null}
     * @private
     */
    this.targetMedia = null;
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
    trace('library-loaded');
    this.context = context;
    this.libav = await LibAV.LibAV();
    trace('libav-instance');

    // **The file is NOT read into memory, and that is the whole point.**
    //
    // An earlier version did `await this.file.arrayBuffer()` and wrote that into the
    // wasm filesystem. For a film that is gigabytes of RAM used twice (the ArrayBuffer
    // AND the wasm copy), the read can take minutes, and on a large file it fails with
    // `NotReadableError` because a single multi-gigabyte read is refused. Reported as
    // "I played a movie and five minutes later there is still no audio".
    //
    // A BLOCK reader device instead reads only what the demuxer asks for, via
    // `file.slice()`, on demand. Measured on a fixture: the demuxer asked for 4 slices
    // and decoding began immediately, and the file size is irrelevant to startup.
    await this.libav.mkblockreaderdev('input', this.file.size);
    this.libav.onblockread = async (name, position, length) => {
      // `length` is a hint; a slice of exactly what was asked for is always valid, and
      // the demuxer will ask again if it needs more. An empty result means the end of
      // the file, which the send call understands.
      const chunk = await this.file.slice(position, position + length).arrayBuffer();
      await this.libav.ff_block_reader_dev_send(name, position, new Uint8Array(chunk));
    };

    const [format, streams] = await this.libav.ff_init_demuxer_file('input');
    this.format = format;
    this.streams = streams;
    trace('demuxed', {
      bytes: this.file.size,
      streams: streams.length,
      codecs: streams.map((entry) => `${entry.codec_type}:${entry.codec_id}`).join(','),
    });

    const stream = streams.filter((entry) => entry.codec_type === 1)[this.trackIndex];
    if (!stream) {
      trace('no-audio-stream', { wanted: this.trackIndex, found: streams.filter((s) => s.codec_type === 1).length });
      throw new Error('That audio track is not in this file.');
    }
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
    trace('decoder-ready', { codecId: stream.codec_id, streamIndex: stream.index });

    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    trace('graph', {
      ctxState: this.context.state,
      ctxRate: this.context.sampleRate,
      destChannels: this.context.destination.channelCount,
      destMax: this.context.destination.maxChannelCount,
      gain: this.gain.gain.value,
    });

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

    // **The seek is in the stream's OWN time base, not microseconds, and that was the
    // bug that made every file play no sound.** The first version passed
    // `seconds * 1e6`, on the assumption that `av_seek_frame` wants microseconds. It
    // does not: it wants the target in the units of the stream's `time_base`.
    // Matroska audio here is `1/1000`, so 0.24 seconds went in as 240000 MILLISECONDS,
    // which is 240 seconds, and every read after it returned end-of-file on a short
    // file. Silent, with no error, because the seek succeeded.
    //
    // `AV_TIME_BASE` (1000000) is used ONLY when the time base is unknown, which is
    // the documented default for `av_seek_frame` when the stream index is -1.
    const num = this.stream.time_base_num;
    const den = this.stream.time_base_den;
    const stamp = num && den ? Math.round((seconds * den) / num) : Math.round(seconds * MICROSECONDS);
    trace('seek', { seconds: Number(seconds.toFixed(2)), stamp, timeBase: `${num ?? '?'}/${den ?? '?'}` });

    // `AVSEEK_FLAG_BACKWARD`: land on the keyframe at or before the target, which is
    // where the decoder has the state to produce correct samples from. A forward
    // seek would start after the target and drop audio.
    const result = await this.libav.av_seek_frame(
      this.format,
      -1,
      stamp,
      0,
      AVSEEK_FLAG_BACKWARD,
    );
    if (result < 0) trace('seek-FAILED', { result });

    // **The decoder is flushed, and skipping this is a real bug that only appears after
    // a seek once the stream has ended.** `fill` passes `fin: true` when it reaches
    // EOF, which makes the helper send a null packet and DRAIN the decoder. A seek
    // moves the demuxer but does not reset the decoder, so the next packet is rejected
    // with "Error submitting the packet to the decoder: End of file". Flushing here
    // returns the decoder to a state that accepts packets, which is what a seek means.
    if (this.decoder) await this.libav.avcodec_flush_buffers(this.decoder);
    // After a seek there is stream left to read, so the decoder may be flushed again
    // when this position reaches its end.
    this.ended = false;
    // The media time the caller asked for. Frames BEFORE this are the tail of the
    // keyframe the backward seek landed on, and they belong to a moment the viewer
    // has already passed, so `schedule` drops them. Without this the audio plays from
    // wherever the keyframe was (which can be seconds early), the position reads
    // short, and the drift corrector fights it in a loop.
    this.targetMedia = seconds;
    this.nextStart = 0;
    // The old anchor describes a position the playhead has left, so it is dropped;
    // the next scheduled buffer establishes a new one.
    this.anchor = null;
    if (this.playing) {
      await this.fill();
      // **The refill timer is re-armed here, and forgetting this was a real bug.**
      // `stopNodes` used to clear it, and `correctDrift` seeks without going through
      // `play`, so the first drift correction stopped refilling permanently: the two
      // seconds already buffered played out and the film fell silent for good, with no
      // error. Re-arming on every seek makes the timer's life independent of who
      // called.
      this.startTimer();
    }
  }

  /**
   * Stop every scheduled buffer. Does NOT touch the refill timer. @private
   */
  stopNodes() {
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // Already finished. Nothing to undo.
      }
    }
    this.nodes = [];
  }

  /** Stop refilling. @private */
  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ensure the refill timer is running. @private */
  startTimer() {
    if (!this.timer) {
      // The callback catches, deliberately. An exception inside a `setInterval`
      // callback is reported to the console but does NOT stop the interval, so a
      // `fill` that throws every tick looks EXACTLY like a decoder that produces
      // nothing: three buffers play, the film goes silent, and the only trace is an
      // unhandled rejection somebody has to notice. Logging the failure and stopping
      // the timer turns that into one legible line.
      this.timer = setInterval(() => {
        void this.fill().catch((error) => {
          trace('fill-FAILED', { error: String(error?.message ?? error) });
          this.stopTimer();
        });
      }, REFILL_INTERVAL_MS);
    }
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
    trace('play', { seconds: Number(seconds.toFixed(2)), state: this.context.state });
    this.playing = true;
    // Re-sought rather than resumed, because a pause may have lasted minutes and the
    // element may have moved. Stops any buffer already scheduled, so there is no
    // double audio.
    await this.seek(seconds);
    await this.fill();
    this.startTimer();
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
    this.stopTimer();
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
    // **One fill at a time, and this is what made the audio stop.**
    //
    // `fill` is async and runs on a timer, so a call that takes longer than the
    // interval overlaps the next one. Both then drive the SAME demuxer and decoder
    // handles through the worker, and the second corrupts the first's state: the
    // decoder reports an error, the promise rejects, and because the rejection was
    // unhandled the audio simply stopped with nothing in the console.
    //
    // Measured as the reported symptom: about 100 ms of sound (exactly the three
    // buffers `seek` fills synchronously, 3 * 1536 / 48000) and then silence until
    // the next seek produced another blip. It reproduced only on a large file, where
    // a fill outlasts the 200 ms interval; a short fixture finishes first, which is
    // why every small-file test passed.
    if (this.filling) return;
    this.filling = true;
    try {
      await this.fillOnce();
    } finally {
      this.filling = false;
    }
    // A periodic proof that refilling continues. Logging only the first three buffers
    // made a WORKING decoder look like a stopped one, which cost real debugging time.
    this.fills = (this.fills ?? 0) + 1;
    if (this.fills % 25 === 0) {
      trace('fill-alive', {
        fills: this.fills,
        scheduledTo: Number(this.nextStart.toFixed(1)),
        audibleNow: Number(this.context.currentTime.toFixed(1)),
      });
    }
  }

  /**
   * One pass of decoding, without the re-entrancy guard that `fill` applies.
   * @private
   */
  async fillOnce() {
    if (this.disposed || !this.libav) return;
    // **The window is measured from what is SCHEDULED, not only from the audio clock.**
    // `context.currentTime` is the right anchor for what is AUDIBLE, but it stands still
    // while the graph is empty, so a loop that aims at
    // `currentTime + DECODE_AHEAD_SECONDS` keeps decoding as fast as it can and
    // overshoots: measured 438 live buffers, 14 seconds of audio, against a 2 second
    // window. `nextStart` is what has been SCHEDULED, and it always advances, so the
    // window is expressed against it and the loop stops when the buffer is genuinely
    // full regardless of the clock.
    let guard = 0;
    if (this.fills === undefined) this.fills = 0;
    this.fills++;

    while (!this.disposed && guard++ < 64) {
      // Where the buffer ends. Never earlier than the playhead plus the window, so a
      // context that has not started yet still fills, and never more than a fixed
      // amount AHEAD of the playhead, which is the bound that actually holds.
      const horizon =
        Math.max(this.context.currentTime, this.nextStart) + DECODE_AHEAD_SECONDS;
      const buffered = this.nextStart - this.context.currentTime;
      if (this.nextStart > 0 && buffered >= DECODE_AHEAD_SECONDS) break;
      if (this.nextStart >= horizon) break;

      // A SMALL read limit, deliberately. This is the demuxer's read size, not the
      // decode target: asking for a megabyte at a time returns tens of seconds of
      // audio in one call, which overshoots the window and holds memory that a seek
      // will only throw away. 64 KiB is a few frames, so the loop exits on the TARGET
      // rather than on how much a read happened to return.
      const [result, byStream] = await this.libav.ff_read_frame_multi(
        this.format,
        this.packets,
        { limit: 64 * 1024 },
      );
      const batch = byStream[this.streamIndex];
      if (batch?.length) {
        // `config.fin` is passed AT MOST ONCE per seek, and that is a real trap rather
        // than tidiness. `fin: true` makes the helper send a null packet that DRAINS the
        // decoder, and draining it twice throws "Error submitting the packet to the
        // decoder: End of file". The refill timer keeps running after the stream ends,
        // so without the `ended` guard every tick past the end would flush again.
        const frames = await this.libav.ff_decode_multi(
          this.decoder,
          this.packets,
          this.frame,
          batch,
          result === this.libav.AVERROR_EOF && !this.ended,
        );
        for (const decoded of frames) {
          this.schedule(decoded);
          // Stop the moment the window is full. One read can decode many frames (a
          // 64 KiB batch of 6-channel audio is several seconds), so without this the
          // loop overshoots the window by whatever the last batch held.
          if (this.nextStart > 0 && this.nextStart - this.context.currentTime >= DECODE_AHEAD_SECONDS) {
            break;
          }
        }
      }

      // Why the read stopped, and what to do about it. **The codes are read from the
      // instance, and hardcoding them was a bug.** `libav.EAGAIN` is `6` and a limited
      // read returns `-6`, so a hardcoded `-11` never matched and every batch looked
      // like the end of the stream: the loop exited and the decoder produced no more
      // audio, which is the silence reported after a couple of seconds.
      if (result === -this.libav.EAGAIN) {
        // The read limit was hit, so there is more to come. This is the COMMON case
        // inside a full window, not an error.
        continue;
      }
      // `libav.AVERROR_EOF`, read from the instance for the same reason.
      if (result === this.libav.AVERROR_EOF) {
        // Marked so the decoder is flushed ONCE. The timer keeps ticking after the end,
        // and a second flush throws; a seek clears this, because after a seek there is
        // more stream to read.
        this.ended = true;
        break;
      }
      // Any other negative is a real read error, and looping on it would spin.
      if (result < 0) throw new Error(`Could not read the audio track (${this.libav.ff_error(result)}).`);
      // A successful read that produced no packets for us means the demuxer is
      // interleaving other streams; keep going rather than stopping.
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

    // Where this frame sits in the FILM, from its own timestamp. This is the audio's
    // real position, and it is what the clock is built from.
    const stamp = decoded.best_effort_timestamp;
    const media =
      stamp != null && decoded.time_base_den
        ? (stamp * decoded.time_base_num) / decoded.time_base_den
        : null;

    // DROP frames from before the position the viewer asked for.
    //
    // A backward seek lands on the keyframe at or before the target, and the decoder
    // then produces every frame from there, so the first ones are the tail of audio
    // the viewer has already passed. Scheduling them would play from the keyframe
    // (up to seconds early), make `position` read behind the picture, and the drift
    // corrector would seek again, which drops these and produces the same frames:
    // the loop the diagnostics showed as a re-seek 130 ms after starting.
    if (media !== null && this.targetMedia != null && media + 0.05 < this.targetMedia) {
      return;
    }

    if (this.scheduled === undefined) this.scheduled = 0;
    if (this.scheduled++ < 3) {
      trace('scheduled', { channels, length, rate: decoded.sample_rate, n: this.scheduled - 1 });
    }

    const buffer = this.context.createBuffer(channels, length, decoded.sample_rate);
    for (let channel = 0; channel < channels; channel++) {
      buffer.copyToChannel(decoded.data[channel], channel);
    }

    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    // Pruned as each buffer finishes. Without this the array grows for the whole
    // film, keeping every decoded AudioBuffer alive: a two hour film is thousands of
    // nodes and hundreds of megabytes that can never be collected, because a finished
    // source node is only released when nothing references it.
    node.addEventListener('ended', () => {
      node.disconnect();
      const at = this.nodes.indexOf(node);
      if (at !== -1) this.nodes.splice(at, 1);
    });
    // Never schedule in the past: after a stall the queue can fall behind the clock,
    // and a start time in the past plays immediately, which is the recovery wanted.
    this.nextStart = Math.max(this.nextStart, this.context.currentTime);
    node.start(this.nextStart);
    this.nodes.push(node);

    // The anchor: the FIRST scheduled frame's own media time, and the audio-clock time
    // it starts at. Everything after is measured from here, so `position` reports where
    // the audio really is rather than where the schedule happens to have reached.
    if (this.anchor === null) {
      this.anchor = { media: media ?? this.targetMedia ?? 0, context: this.nextStart };
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
    // **The timer is stopped FIRST, and skipping it was a real crash.** `fill` checks
    // `this.disposed` at its top, but the callback from an already-scheduled interval
    // had `this.libav` read to null underneath it and threw
    // "Cannot read properties of null (reading 'EAGAIN')" from inside the tick.
    this.stopTimer();
    this.stopNodes();
    this.libav = null;
  }
}
