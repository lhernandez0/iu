/**
 * Playing a file whose audio the browser cannot decode, by re-encoding that audio to AAC
 * while the video is copied untouched.
 *
 * ## The shape
 *
 * A media element can only play codecs it already supports, so a file whose audio is AC-3
 * or E-AC-3 plays its picture and emits **silence**, with no `MediaError` to catch. No
 * remux helps: remuxing hands the element the same codec it already refused. The audio has
 * to be decoded and re-encoded to something the element plays, which is AAC.
 *
 * The work itself lives in `transcode-worker.js`, **off the main thread**, and this module
 * is the bridge to it: it creates a `MediaSource`, checks the codec the worker names, and
 * appends the fragments the worker streams back.
 *
 * ## Why the work is in a worker
 *
 * **Measured: on the main thread it blocked the page hard enough that Chrome offered to
 * kill the tab.** During a conversion the main-thread heartbeat fell from about 10 ticks a
 * second to **0**, and heap climbed toward 400 MB. The same file through a Worker left the
 * page at its normal 10 ticks a second. The main thread never loads 6 MB of WebAssembly and
 * never runs FFmpeg; it appends bytes.
 *
 * ## Seeking, which is the standard segmented-media problem
 *
 * **Measured: a jump into the middle of a film stalled for 20 seconds on a 10-minute file,
 * and scales with how far ahead the jump is.** The transcoder is a single forward pass, so
 * it cannot serve a region it has not reached without decoding everything in between: on a
 * two-hour film, tens of minutes.
 *
 * The fix is the one every streaming player uses. When the playhead moves outside what has
 * been produced, the worker re-runs the conversion from the keyframe before the target
 * (`Conversion.cancel()`, then a new conversion with `trim.start`), and each pass's output
 * is placed on the timeline with **`SourceBuffer.timestampOffset`**, which the platform
 * provides for exactly this (the same mechanism DASH and HLS segment delivery uses). A pass
 * numbers its output from zero; the offset says where that pass really belongs.
 *
 * A seek is asked for once, when the produced media is about to run out, rather than on
 * every `timeupdate`, so conversions are not cancelled in a loop.
 *
 * ## Why this is not a second audio clock
 *
 * An earlier design decoded to PCM and played it through Web Audio beside the element's
 * video. That is two clocks in one page, and every bug the feature had was the two clocks
 * parting company. Here the element plays the transcoded stream itself, so playback,
 * seeking, pausing, rate and keeping sound with picture are all the element's job. The most
 * this module does is tell the worker where the playhead is.
 */

/** Where the worker lives, relative to this file. */
const WORKER_URL = './transcode-worker.js';

/**
 * How close to the produced edge the playhead may get before a seek is re-run, in seconds.
 *
 * Not zero, because the element reads a little ahead of the playhead and `timeupdate` is
 * coarse, so a request per event would cancel conversions in a loop. A few seconds of slack
 * is what playback needs to survive a scheduling hiccup, and it is the same reasoning as the
 * decode-ahead window in the old design.
 */
const SEEK_MARGIN_SECONDS = 4;

/** @type {Worker|null} */
let sharedWorker = null;
/** The next request id. */
let nextRequest = 1;
/** Pending decode probes, by id. @type {Map<number, (ok: boolean) => void>} */
const pendingProbes = new Map();

/**
 * Whether the bundled decoder will answer a decode question for a codec id.
 *
 * The decoder in the worker knows whether it carries a codec, so this asks it rather than
 * keeping a second list here that could disagree.
 *
 * @param {number} codecId An FFmpeg `AVCodecID`.
 * @returns {Promise<boolean>}
 */
export async function canDecode(codecId) {
  const worker = ensureWorker();
  if (!worker) return false;
  const id = nextRequest++;
  return new Promise((resolve) => {
    pendingProbes.set(id, resolve);
    worker.postMessage({ type: 'canDecode', id, codecId });
  });
}

/**
 * Start the shared worker, or return null if workers are unavailable.
 *
 * Reused across conversions because constructing it (and the WASM it loads) is the
 * expensive part. A module `Worker` is available wherever this extension runs, so the null
 * path is a guard rather than an expected case.
 *
 * @returns {Worker|null}
 */
function ensureWorker() {
  if (sharedWorker) return sharedWorker;
  try {
    sharedWorker = new Worker(new URL(WORKER_URL, import.meta.url), { type: 'module' });
    // **A worker that fails to LOAD reports nothing.** It fires an `error` event on the
    // Worker object and then simply never speaks, so without this the viewer shows a picture
    // with no sound and not one line of explanation, which is the failure this whole feature
    // exists to remove. This turns that into a console line.
    sharedWorker.addEventListener('error', (event) => {
      console.log(`[iu] transcode step=worker-error error=${String(event.message ?? event)}`);
    });
    sharedWorker.addEventListener('message', (event) => {
      const message = event.data;
      const resolve = pendingProbes.get(message.id);
      if (resolve) {
        pendingProbes.delete(message.id);
        resolve(Boolean(message.ok));
      }
    });
    return sharedWorker;
  } catch (error) {
    console.log(`[iu] transcode step=worker-FAILED error=${String(error?.message ?? error)}`);
    return null;
  }
}

/**
 * Transcode what the browser cannot play, streaming into the element, and keep it fed
 * across seeks.
 *
 * @param {File|Blob} file
 * @param {HTMLVideoElement} video The element being played, so seeks can be observed.
 * @param {{onProgress?: (fraction: number) => void}} [options]
 * @returns {Promise<{url: string, done: Promise<void>, revoke: () => void}>}
 */
export async function transcodeForElement(file, video, options = {}) {
  const worker = ensureWorker();
  if (!worker) throw new Error('This browser cannot run the audio decoder.');

  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);

  let sourceBuffer = null;
  /** The offset currently applied to the source buffer, so it is only written when it changes. */
  let appliedOffset = null;
  let sawInit = false;
  let revoked = false;
  let disposed = false;
  /** @type {unknown} */
  let failure = null;

  /** The mime string, which only the worker knows. @type {string|null} */
  let mime = null;
  /** The file's duration in seconds, from the worker. @type {number|null} */
  let duration = null;
  /** @type {(value: string) => void} */
  let announceMime;
  const mimeReady = new Promise((resolve) => {
    announceMime = resolve;
  });

  /**
   * Fragments waiting to be appended, in arrival order.
   *
   * **An ordered queue rather than appending directly**, because MSE's one rule is that
   * media may not precede its initialisation segment and because `appendBuffer` throws while
   * a previous append is still being parsed. The head's `init` tag makes the first rule
   * structural, and `updating` makes the second.
   *
   * @type {Array<{bytes: Uint8Array, init: boolean, offset: number}>}
   */
  const queue = [];

  /** The pass currently expected, so chunks from a cancelled pass are dropped. */
  let activePass = 0;
  /** The offset to place the active pass at, in source seconds. */
  let passOffset = 0;
  /** Whether the active pass has produced anything yet. */
  let passProduced = false;
  /** The source time the produced media reaches, in seconds. */
  let producedThrough = 0;
  /** The highest source time seen in the active pass, used to advance `producedThrough`. */
  let passCursor = 0;

  /**
   * Append queued fragments until the buffer is busy or the queue drains.
   *
   * The offset is written only when it differs, because assigning `timestampOffset` while
   * the buffer is updating throws, and a needless write is a needless chance to hit that.
   */
  const pump = () => {
    if (disposed || !sourceBuffer || sourceBuffer.updating) return;
    const head = queue[0];
    if (!head) return;
    // MSE's one rule: media may not precede the initialisation segment.
    if (!head.init && !sawInit) return;
    try {
      if (appliedOffset !== head.offset) {
        sourceBuffer.timestampOffset = head.offset;
        appliedOffset = head.offset;
      }
      sourceBuffer.appendBuffer(head.bytes);
      if (head.init) sawInit = true;
      queue.shift();
    } catch (error) {
      if (error?.name === 'QuotaExceededError') {
        // The element has not played far enough to make room. Retried on `updateend`.
        return;
      }
      failure = error;
    }
  };

  /**
   * Ask the worker for a pass starting at the keyframe before the target.
   *
   * @param {number} seconds
   */
  let lastSeekAt = -1;
  const requestSeek = (seconds) => {
    // One request per position: `timeupdate` fires throughout the wait and each one would
    // otherwise cancel the pass the previous one started.
    if (Math.abs(seconds - lastSeekAt) < SEEK_MARGIN_SECONDS) return;
    lastSeekAt = seconds;
    activePass += 1;
    passOffset = seconds;
    passProduced = false;
    passCursor = 0;
    seekAskedAt = Date.now();
    console.log(`[iu] transcode step=seek-requested at=${seconds.toFixed(1)}`);
    worker.postMessage({ type: 'seek', id: activePass, file, seconds });
  };
  /** When the current seek was requested, for the time-to-first-fragment measurement. */
  let seekAskedAt = 0;

  /**
   * Keep the element fed as the playhead moves.
   *
   * Seeking is asked for only when the playhead is about to leave what has been produced,
   * which is the moment a stall would otherwise begin. `producedThrough > 0` is what keeps
   * this from firing at startup: before the first fragment arrives nothing is produced, and
   * a request then would cancel the very pass the caller just started.
   */
  const onTimeUpdate = () => {
    if (disposed || sourceBuffer?.updating) return;
    if (producedThrough <= 0) return;
    if (video.currentTime > producedThrough - SEEK_MARGIN_SECONDS) {
      requestSeek(video.currentTime);
    }
  };

  /**
   * Handle one message from the worker.
   *
   * @param {MessageEvent} event
   */
  const onMessage = (event) => {
    const message = event.data;
    // Chunks from a superseded pass are dropped rather than appended, so a seek mid-pass
    // cannot interleave two streams into one buffer.
    if (message.id !== activePass) return;

    if (message.type === 'init') {
      queue.push({ bytes: message.bytes, init: true, offset: message.offset ?? passOffset });
      pump();
      return;
    }
    if (message.type === 'media') {
      if (seekAskedAt && !passProduced) {
        console.log(`[iu] transcode step=seek-first-fragment ms=${Date.now() - seekAskedAt}`);
      }
      passProduced = true;
      passCursor += 1;
      // Fragments carry no timestamp here; the pass's offset plus a running estimate of its
      // produced span is enough to know when the element will run dry. `minimumFragmentDuration`
      // is 1 second, so a fragment advances the produced edge by about a second.
      producedThrough = Math.max(producedThrough, (message.offset ?? passOffset) + passCursor);
      queue.push({ bytes: message.bytes, init: false, offset: message.offset ?? passOffset });
      pump();
      return;
    }
    if (message.type === 'mime') {
      mime = message.mime;
      duration = message.duration;
      announceMime(mime);
      applyDuration();
    } else if (message.type === 'progress') {
      options.onProgress?.(Math.min(1, message.progress));
    } else if (message.type === 'error') {
      failure = new Error(message.message);
      disposed = true;
    }
  };

  /** Push the worker's duration onto the `MediaSource`, once both are ready. */
  const applyDuration = () => {
    if (duration == null || mediaSource.readyState !== 'open') return;
    try {
      mediaSource.duration = duration;
    } catch {
      // A source that has ended, or a duration the platform rejects. Not fatal: the element
      // still plays, it simply reports its own duration.
    }
  };

  const onUpdateEnd = () => pump();

  mediaSource.addEventListener(
    'sourceopen',
    () => {
      void (async () => {
        try {
          const codec = await mimeReady;
          sourceBuffer = mediaSource.addSourceBuffer(codec);
          sourceBuffer.mode = 'segments';
          sourceBuffer.addEventListener('updateend', onUpdateEnd);
          applyDuration();
          pump();
        } catch (error) {
          failure = error;
        }
      })();
    },
    { once: true },
  );

  video.addEventListener('timeupdate', onTimeUpdate);
  // **`seeking`, not `seeked`, and this is the fix for the stall.** A stall is exactly the
  // state where `timeupdate` STOPS firing, so a handler that only listens for `timeupdate`
  // never gets a chance to notice that the playhead has jumped past what was produced: the
  // element sits waiting, no event arrives, and the seek is never asked for. `seeking` fires
  // the moment `currentTime` is written, before the wait begins, which is the only reliable
  // signal a jump happened.
  video.addEventListener('seeking', onTimeUpdate);

  worker.addEventListener('message', onMessage);
  // The initial pass is told to start at zero; the worker works out the keyframe for a
  // later `seek`.
  worker.postMessage({ type: 'convert', id: activePass, file, start: 0 });

  return {
    url,
    // `done` resolves immediately: production continues in the background across seeks, so
    // there is no single completion to await. Errors surface through the console trace and
    // the element's own state.
    done: Promise.resolve(),
    revoke: () => {
      disposed = true;
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('seeking', onTimeUpdate);
      worker.removeEventListener('message', onMessage);
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch {
        // Never opened, or already ended.
      }
      URL.revokeObjectURL(url);
    },
  };
}
