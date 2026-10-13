/**
 * The transcode, off the main thread.
 *
 * ## Why this is a worker
 *
 * **Measured: running it on the main thread blocks the page hard enough that Chrome
 * offers to kill the tab.** Decoding and re-encoding a film is sustained CPU, and on the
 * main thread that is a frozen viewer: the heartbeat interval dropped from ~10 ticks a
 * second to **0**, heap climbed toward 400 MB, and a large file sustained it long enough
 * to trigger the browser's "page is not responding" prompt.
 *
 * Moving the same work into a Worker kept the main thread at its normal ~10 ticks a
 * second for the whole file, so the page stays responsive and Chrome never intervenes.
 * The main thread's only job becomes attaching a `MediaSource` and appending the bytes
 * this worker produces.
 *
 * ## What runs here
 *
 * Mediabunny reads the file, decodes and re-encodes the audio through the two libav.js
 * plugins below, and writes a fragmented MP4 back out as chunks through
 * `StreamTarget`s. The chunks are posted to the main thread, which appends them to a
 * `SourceBuffer`. See ADR 0012 for why the container is mediabunny's job.
 *
 * ## The protocol
 *
 * `{ type: 'canDecode', id, codecId }` answers whether the bundled FFmpeg can decode a
 * codec, so the main thread never loads 6 MB of WebAssembly itself.
 *
 * `{ type: 'convert', id, file }` runs a conversion, then streams
 * `{ type: 'mime' }` once, `{ type: 'init' }` and `{ type: 'media' }` as they are
 * produced, `{ type: 'progress' }` as it advances, and finally `{ type: 'done' }` or
 * `{ type: 'error' }`. Every message carries the request `id` except the stream of
 * chunks, which are implicitly the current conversion.
 */

import {
  Input,
  Output,
  Conversion,
  BlobSource,
  ALL_FORMATS,
  Mp4OutputFormat,
  StreamTarget,
  CustomAudioDecoder,
  CustomAudioEncoder,
  registerDecoder,
  registerEncoder,
  EncodedPacket,
  EncodedPacketSink,
  AudioSample,
} from '../vendor/mediabunny.js';

/** Where the built decoder lives, relative to this file. Gitignored, shipped in the ZIP. */
const DECODER_URL = '../vendor/libav.js';

/**
 * `AV_SAMPLE_FMT_FLT`: planar float. What libav's `eac3` decoder emits and what its `aac`
 * encoder wants, so the samples never leave this format.
 */
const AV_SAMPLE_FMT_FLT = 8;

/**
 * The standard FFmpeg channel-layout MASK for each channel count.
 *
 * `AV_CH_LAYOUT_MONO` (1), `STEREO` (3), `5POINT1` (0x3F), `7POINT1` (0x63F). A standard
 * layout is used rather than the decoded one on purpose: E-AC-3 in the wild is often
 * 5.1(side), whose mask has no AAC equivalent, so FFmpeg falls back to writing a Program
 * Config Element, which Chrome's MSE rejects outright. The channel count is what matters
 * for playback; a side-versus-back distinction is not one a learner hears.
 */
const CHANNEL_LAYOUTS = { 1: 0x4, 2: 0x3, 6: 0x3f, 8: 0x63f };

/** FFmpeg `AVCodecID`s for the audio codecs the custom decoder answers for. */
const CODEC_IDS = { ac3: 86019, eac3: 86056, dts: 86020, truehd: 86060, mlp: 86045 };

/** AAC bitrate, in bits per second. Generous for speech, small against the video. */
const AUDIO_BITRATE = 192_000;

/** @type {Promise<any>|null} */
let libavPromise = null;

/**
 * One libav instance for the worker's life.
 *
 * Reused because constructing the WASM instance is the expensive part, and a probe and a
 * conversion both need it. Created lazily so a worker that only ever answers a probe does
 * not pay for a decoder it never opens.
 *
 * @returns {Promise<any>}
 */
function loadLibav() {
  if (!libavPromise) {
    libavPromise = import(DECODER_URL)
      .then(({ default: LibAV }) => LibAV.LibAV({ noworker: true }))
      .catch((error) => {
        libavPromise = null;
        throw error;
      });
  }
  return libavPromise;
}

/**
 * Log one step under the extension's diagnostic prefix.
 *
 * Its own copy rather than an import from `diagnostics.js`: this module is the one that
 * fails when the decoder is missing or broken, and reaching into the module graph it is
 * diagnosing is the wrong dependency.
 *
 * @param {string} step
 * @param {Record<string, unknown>} [fields]
 */
function trace(step, fields = {}) {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`);
  console.log(`[iu] transcode step=${step}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

/** Join two `Float32Array`s. The one operation the encoder's rechunker does. */
function concat(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const joined = new Float32Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

/**
 * The custom decoder: libav.js for AC-3, E-AC-3 and the other codecs the browser lacks.
 *
 * Mediabunny constructs one of these per track, hands it the decoder config through the
 * instance properties it sets after construction, then calls `decode` once per encoded
 * packet. Each decoded frame becomes an `AudioSample` and goes back through `onSample`.
 */
class LibavAudioDecoder extends CustomAudioDecoder {
  /**
   * Whether this class answers for a codec. Mediabunny asks before it uses the class, so
   * a codec with no libav id is left to the browser.
   *
   * @param {string} codec
   * @returns {boolean}
   */
  static supports(codec) {
    return codec in CODEC_IDS;
  }

  /** Open the libav decoder. */
  async init() {
    this.libav = await loadLibav();
    const id = CODEC_IDS[this.codec];
    // Opened from a codecpar built to match what mediabunny described. The description it
    // carries is FFmpeg's extradata, which the parser needs.
    const par = await this.libav.avcodec_parameters_alloc();
    await this.libav.AVCodecParameters_codec_id_s(par, id);
    const channels = this.config?.numberOfChannels;
    const sampleRate = this.config?.sampleRate;
    if (channels) await this.libav.AVCodecParameters_channels_s(par, channels);
    if (sampleRate) await this.libav.AVCodecParameters_sample_rate_s(par, sampleRate);
    const [, decoder, packet, frame] = await this.libav.ff_init_decoder(id, par);
    this.decoder = decoder;
    this.packet = packet;
    this.frame = frame;
    this.nextPts = 0;
  }

  /**
   * Decode one packet and emit whatever frames come out.
   *
   * @param {any} packet One `EncodedPacket` from mediabunny.
   */
  async decode(packet) {
    // The output `pts` is ignored; each sample is stamped from the PACKET, which is what
    // keeps the audio on the video's timeline.
    const input = { data: packet.data, pts: 0, stream_index: 0 };
    const frames = await this.libav.ff_decode_multi(this.decoder, this.packet, this.frame, [input], false);
    for (const decoded of frames) this.emit(decoded, packet.timestamp);
  }

  /** Decode whatever the decoder is still holding, then stop. */
  async flush() {
    const frames = await this.libav.ff_decode_multi(this.decoder, this.packet, this.frame, [], true);
    for (const decoded of frames) this.emit(decoded, this.nextPts / (this.config?.sampleRate ?? 48000));
  }

  /**
   * Turn one decoded frame into an `AudioSample`.
   *
   * @param {any} decoded
   * @param {number} timestamp Presentation timestamp, in seconds.
   */
  emit(decoded, timestamp) {
    const channels = decoded.channels ?? this.config?.numberOfChannels ?? 2;
    const sampleRate = decoded.sample_rate ?? this.config?.sampleRate ?? 48000;
    const frames = decoded.data[0].length;
    // libav decodes to FLTP, one plane per channel, and `f32-planar` wants exactly that:
    // the planes concatenated, not interleaved. No transpose, and it stays in float.
    const planar = new Float32Array(frames * channels);
    const planes = decoded.data.length > 1 ? decoded.data : Array.from({ length: channels }, () => decoded.data[0]);
    for (let channel = 0; channel < channels; channel++) {
      planar.set(planes[channel] ?? planes[0], channel * frames);
    }
    this.nextPts = Math.round(timestamp * sampleRate) + frames;
    this.onSample(
      new AudioSample({ data: planar, format: 'f32-planar', numberOfChannels: channels, sampleRate, timestamp }),
    );
  }

  /** Release the decoder. libav.js frees it with the instance. */
  async close() {}
}

/**
 * The custom encoder: libav.js's AAC encoder for output the element can play.
 *
 * **This exists because the browser cannot be relied on to have one.** Measured:
 * `canEncodeAudio('aac')` is false in headless Chrome, and Firefox ships no AAC encoder at
 * all. FFmpeg's own AAC encoder is already in the build (`encoder-aac`).
 */
class LibavAacEncoder extends CustomAudioEncoder {
  /**
   * @param {string} codec
   * @returns {boolean}
   */
  static supports(codec) {
    return codec === 'aac';
  }

  /** Open the libav encoder and read back its AudioSpecificConfig. */
  async init() {
    this.libav = await loadLibav();
    const channels = this.config?.numberOfChannels ?? 2;
    const sampleRate = this.config?.sampleRate ?? 48000;
    const layout = CHANNEL_LAYOUTS[channels] ?? 0x3;
    const [, encoder, frame, packet, frameSize] = await this.libav.ff_init_encoder('aac', {
      ctx: {
        bit_rate: this.config?.bitrate ?? AUDIO_BITRATE,
        sample_fmt: AV_SAMPLE_FMT_FLT,
        sample_rate: sampleRate,
        channels,
        channel_layout: layout,
      },
      time_base: [1, sampleRate],
    });
    this.encoder = encoder;
    this.frame = frame;
    this.packet = packet;
    this.frameSize = frameSize;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.layout = layout;
    /**
     * The AAC `AudioSpecificConfig` from the encoder's codecpar.
     *
     * **Without it the muxer refuses every packet.** AAC carried as raw frames (what this
     * encoder emits) is not self-describing, so mediabunny cannot tell the channel count
     * or sample rate, and it fails with "Couldn't parse ADTS header... provide a
     * description". The config comes from the encoder, which is where it has to come from.
     *
     * @private
     */
    this.description = null;
    /** Whether the first packet has gone, the only one that carries the config. @private */
    this.sentConfig = false;
    /** Samples left over from the previous sample, per channel. @private */
    this.carry = Array.from({ length: channels }, () => new Float32Array(0));
    this.pts = 0;
    const codecpar = await this.libav.avcodec_parameters_alloc();
    await this.libav.avcodec_parameters_from_context(codecpar, encoder);
    const copied = await this.libav.ff_copyout_codecpar(codecpar);
    if (copied?.extradata) this.description = new Uint8Array(copied.extradata);
  }

  /**
   * Encode one sample and emit whatever whole frames it completes.
   *
   * @param {any} sample One `AudioSample` from mediabunny.
   */
  async encode(sample) {
    const channels = sample.numberOfChannels;
    const frames = sample.numberOfFrames;
    if (this.carry.length !== channels) {
      this.carry = Array.from({ length: channels }, () => new Float32Array(0));
    }
    // The encoder demands exactly `frameSize` samples per frame and rejects anything else,
    // and mediabunny's samples are variable length, so the remainder waits in `carry`.
    for (let channel = 0; channel < channels; channel++) {
      const plane = new Float32Array(frames);
      sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
      this.carry[channel] = concat(this.carry[channel], plane);
    }
    await this.drain(false);
  }

  /**
   * Emit the last partial frame, zero-padded, and flush the encoder.
   *
   * Zero-padding rather than dropping keeps the tail's duration right. A dropped tail is a
   * few milliseconds of missing sound at the end of a film: silent, and hard to notice,
   * which is why it is done deliberately.
   */
  async flush() {
    const held = this.carry[0]?.length ?? 0;
    if (held % this.frameSize !== 0) {
      for (let channel = 0; channel < this.channels; channel++) {
        const padded = new Float32Array(Math.ceil(held / this.frameSize) * this.frameSize);
        padded.set(this.carry[channel], 0);
        this.carry[channel] = padded;
      }
    }
    await this.drain(true);
  }

  /**
   * Encode every whole frame currently in the carry.
   *
   * @param {boolean} fin Whether this is the last drain, so the encoder should flush.
   * @private
   */
  async drain(fin) {
    const encodable = [];
    let length = Math.min(...this.carry.map((plane) => plane.length));
    let at = 0;
    while (at + this.frameSize <= length) {
      encodable.push({
        data: this.carry.map((plane) => plane.slice(at, at + this.frameSize)),
        channel_layout: this.layout,
        format: AV_SAMPLE_FMT_FLT,
        pts: this.pts,
        sample_rate: this.sampleRate,
      });
      this.pts += this.frameSize;
      at += this.frameSize;
    }
    for (let channel = 0; channel < this.channels; channel++) {
      this.carry[channel] = this.carry[channel].slice(at);
      length = this.carry[channel].length;
    }
    if (!encodable.length && !fin) return;

    const packets = await this.libav.ff_encode_multi(this.encoder, this.frame, this.packet, encodable, fin);
    for (const packet of packets) {
      // The `AudioSpecificConfig` rides on the FIRST packet only, which is where the muxer
      // reads it.
      const meta = this.sentConfig
        ? undefined
        : {
            decoderConfig: {
              codec: 'mp4a.40.2',
              numberOfChannels: this.channels,
              sampleRate: this.sampleRate,
              description: this.description ?? undefined,
            },
          };
      this.sentConfig = true;
      this.onPacket(
        new EncodedPacket(
          new Uint8Array(packet.data),
          'key',
          packet.pts / this.sampleRate,
          packet.duration / this.sampleRate,
        ),
        meta,
      );
    }
  }

  /** Release the encoder. libav.js frees it with the instance. */
  async close() {}
}

registerDecoder(LibavAudioDecoder);
registerEncoder(LibavAacEncoder);

/**
 * Split a stream of MP4 bytes into one initialisation segment and the media after it.
 *
 * **`Mp4OutputFormat` writes everything through one target**, in order: `ftyp`, `moov`,
 * then `moof`/`mdat` fragments. A single write can contain the end of one box and the
 * start of the next, so the initialisation-to-media boundary is inside a write. MSE
 * requires the initialisation segment to be appended before any media, so the boundary is
 * found by reading box headers here rather than guessed.
 *
 * Only the top level is parsed, which is all the boundary needs: the init boxes are `ftyp`
 * and `moov`, and media is everything from the first `moof` or `mdat` onward.
 */
class Segmenter {
  /**
   * @param {(bytes: Uint8Array, init: boolean) => void} emit
   */
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
      // A size of 0 means "to the end of file", which cannot happen here; 1 means a 64-bit
      // size follows.
      const boxSize = size === 1 ? readUint64(this.buffer, 8) : size;
      if (boxSize < 8 || this.buffer.length < boxSize) return;
      const box = this.buffer.slice(0, boxSize);
      this.buffer = this.buffer.slice(boxSize);
      if (!this.inMedia && (type === 'moof' || type === 'mdat')) this.inMedia = true;
      // The init boxes (`ftyp`, `moov`) are handed over with `init: true`, and everything
      // from the first media box on with `init: false`.
      this.emit(box, !this.inMedia);
    }
  }
}

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
 * Run one conversion, posting its output to the main thread as it is produced.
 *
 * @param {File|Blob} file
 * @param {number} id The request id, echoed on every chunk so a stale conversion's output
 *   cannot be mistaken for the current one.
 * @param {number} start Where the conversion should begin, in seconds of the source. 0
 *   for the initial open; a keyframe time after a seek.
 */
async function convert(file, id, start = 0) {
  const tOpen = Date.now();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

  // The mime string must name the OUTPUT's codecs. The video is copied, so its codec
  // string comes from the input track, and asking the track rather than hardcoding is what
  // keeps a 1080p High-profile film from being announced as Baseline, which the browser
  // then refuses.
  const video = await input.getPrimaryVideoTrack();
  const videoCodec = video ? await video.getCodecParameterString() : null;
  // **The duration is sent explicitly.** A fragmented MP4 does not put the total duration
  // where the element can read it from the init segment, so without this the element
  // reports `Infinity` (and the scrubber shows no end) until production finishes, which for
  // a film is minutes. `computeDuration` reads it from the container up front.
  const duration = await input.computeDuration();
  trace('convert-open', { ms: Date.now() - tOpen, start: Number(start.toFixed(1)) });
  self.postMessage({
    id,
    type: 'mime',
    mime: videoCodec ? `video/mp4; codecs="${videoCodec},mp4a.40.2"` : 'video/mp4; codecs="mp4a.40.2"',
    duration,
  });

  // The byte stream is split into init and media as it arrives, so the main thread gets
  // chunks it can append in order without re-deriving the boundary. **Each chunk carries
  // the source time this pass starts at**, which is the offset the main thread sets on the
  // source buffer, because a pass from a keyframe numbers its own output from zero.
  const segmenter = new Segmenter((bytes, init) => {
    self.postMessage({ id, type: init ? 'init' : 'media', bytes, offset: start }, [bytes.buffer]);
  });
  const target = new StreamTarget(
    new WritableStream({
      write(chunk) {
        segmenter.push(chunk.data);
      },
    }),
  );

  const output = new Output({
    // **Plain fragmented MP4, NOT `CmafOutputFormat`.** Measured on a 189 MB file: CMAF
    // emits the fragments on time (`onMoof` fires every ~1s) but ACCUMULATES them and
    // writes the whole 184 MB as ONE chunk at the very end, so the element gets nothing to
    // play until the conversion is finished. `Mp4OutputFormat` with `fastStart:
    // 'fragmented'` writes each fragment as it is made, so playback begins about a second
    // in. The bytes are the same shape; only the delivery differs.
    format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
    target,
  });

  const conversion = await Conversion.init({
    input,
    output,
    // The video is copied, never re-encoded: no picture is touched, and it is the expensive
    // half by byte count. The audio is transcoded to AAC because that is the only way an
    // E-AC-3 film gets sound at all.
    video: {},
    audio: { codec: 'aac', bitrate: AUDIO_BITRATE },
    // A seek re-runs this from a keyframe time, so the output begins there rather than at
    // zero. The main thread places it on the timeline with `timestampOffset`.
    trim: start > 0 ? { start } : undefined,
  });
  conversion.onProgress = (progress) => self.postMessage({ id, type: 'progress', progress });
  current = conversion;
  try {
    await conversion.execute();
  } finally {
    current = null;
  }
  self.postMessage({ id, type: 'done' });
}

/**
 * The keyframe at or before a time, in seconds.
 *
 * **This is the industry-standard segment boundary.** A seek can only start where the
 * video can be decoded from nothing, which is a key packet, so the conversion is re-run
 * from here rather than from the requested time. The gap between the two is under a
 * second of extra audio to decode, which is why the approximation is invisible.
 *
 * @param {any} input
 * @param {number} seconds
 * @returns {Promise<number>}
 */
async function keyframeAtOrBefore(input, seconds) {
  const video = await input.getPrimaryVideoTrack();
  if (!video) return Math.max(0, seconds);
  try {
    const sink = new EncodedPacketSink(video);
    // `getKeyPacket` returns the last key packet with a timestamp at or before the given
    // time, which is exactly the decodable starting point.
    const packet = await sink.getKeyPacket(seconds);
    return packet ? packet.timestamp : 0;
  } catch {
    return Math.max(0, seconds);
  }
}

/** The conversion currently running, so a new request can cancel it. */
let current = null;

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'canDecode') {
    loadLibav()
      .then((libav) => libav.avcodec_find_decoder(message.codecId))
      .then((found) => self.postMessage({ id: message.id, ok: Boolean(found) }))
      .catch((error) => self.postMessage({ id: message.id, ok: false, error: String(error?.message ?? error) }));
    return;
  }
  if (message.type === 'convert') {
    convert(message.file, message.id, message.start ?? 0).catch((error) => {
      self.postMessage({ id: message.id, type: 'error', message: String(error?.message ?? error) });
    });
  }
  if (message.type === 'seek') {
    // **A seek past what has been produced cannot be answered by waiting.** The worker is a
    // single forward pass, so it cancels the running conversion and starts a new one at the
    // keyframe before the target, which the main thread places on the timeline. This is
    // what makes a jump into the middle of a long film take seconds instead of tens of
    // minutes.
    void (async () => {
      const t0 = Date.now();
      // A fresh `Input` for the keyframe lookup: the conversion's own input belongs to the
      // conversion being cancelled, and reading the container for one packet is cheap.
      const probe = new Input({ source: new BlobSource(message.file), formats: ALL_FORMATS });
      const start = await keyframeAtOrBefore(probe, message.seconds);
      trace('seek-locate', { ms: Date.now() - t0, keyframe: Number(start.toFixed(1)) });
      const t1 = Date.now();
      if (current) {
        try {
          await current.cancel();
        } catch {
          // Already finishing; the conversion it was cancelling is done.
        }
      }
      trace('seek-cancelled', { ms: Date.now() - t1 });
      await convert(message.file, message.id, start);
    })().catch((error) => {
      self.postMessage({ id: message.id, type: 'error', message: String(error?.message ?? error) });
    });
  }
});
