/**
 * Giving the element a stream it can play, by re-encoding the audio it cannot.
 *
 * ## The shape
 *
 * A media element plays only the codecs its browser has. A file whose audio is AC-3 or
 * E-AC-3 plays its picture and emits **silence**, with no error to catch, and no remux
 * can help because remuxing hands the element the same codec it already refused. So the
 * audio is decoded and re-encoded to AAC, the video is copied untouched, and the result
 * is fed to the element as one fragmented MP4. The element then owns playback, so there
 * is **no second audio clock** and nothing to keep in sync. See ADR 0012.
 *
 * The work itself is in `transcode-worker.js`. This module is the bridge: it creates the
 * `MediaSource`, places the worker's fragments on the timeline, and keeps the buffer
 * from growing without bound.
 *
 * ## Why the fragments are placed, not merely appended
 *
 * A seek re-runs the conversion from a keyframe, and that pass numbers its own output
 * from zero. **`SourceBuffer.timestampOffset`** is the platform API that says where a
 * segment really belongs, and it is what every streaming player uses for exactly this (it
 * is the DASH and HLS segment model). So each chunk carries its pass's offset and the
 * buffer is told before appending.
 *
 * ## What is deliberately NOT here
 *
 * No seeking of the media for synchronisation, no drift corrector, no second clock. The
 * element is the only clock, and the most this module does is tell the worker where the
 * playhead has gone.
 */

/** Where the worker lives, relative to this file. */
const WORKER_URL = './transcode-worker.js';

/**
 * How close to the produced edge the playhead may get before a seek is re-run, in seconds.
 *
 * Not zero: the element reads a little ahead of the playhead and `timeupdate` is coarse,
 * so a request per event would cancel passes in a loop. A few seconds is what playback
 * needs to survive a scheduling hiccup.
 */
const SEEK_MARGIN_SECONDS = 4;

/**
 * How much produced media to keep behind the playhead before evicting it, in seconds.
 *
 * **Deliberately generous.** Eviction frees memory, but a viewer who seeks back into an
 * evicted range forces the range to be re-produced, which is a whole pass. Keeping minutes
 * behind means an ordinary back-and-forth never trips it, while a two-hour film still
 * cannot grow the buffer to the whole film.
 *
 * This is a **flat buffer**, not an evolving one. `SourceBuffer.remove` on modern Chrome
 * uses an internal GC and is not the O(n) memory thrash it once was.
 */
const EVICT_BEHIND_SECONDS = 180;

/**
 * How long a seek must be quiet before it is acted on, in milliseconds.
 *
 * Dragging a scrubber fires many `seeking` events a second. Acting on each one would
 * cancel a pass faster than it can start, so nothing would ever complete. This lets the
 * drag settle and acts on where it stopped.
 */
const SEEK_SETTLE_MS = 200;

/** @type {Worker|null} */
let sharedWorker = null;
/** The next request id. */
let nextRequest = 1;

/**
 * Start the shared worker, or return null if workers are unavailable.
 *
 * Reused across conversions because constructing it is the expensive part and the coder
 * packages it loads are slower still. A module `Worker` is available wherever this
 * extension runs, so the null path is a guard rather than an expected case.
 *
 * @returns {Worker|null}
 */
function ensureWorker() {
  if (sharedWorker) return sharedWorker;
  try {
    sharedWorker = new Worker(new URL(WORKER_URL, import.meta.url), { type: 'module' });
    // **A worker that fails to LOAD reports nothing.** It fires an `error` event and then
    // never speaks, so without this a film plays with no sound and no explanation, which
    // is the failure this whole feature exists to remove.
    sharedWorker.addEventListener('error', (event) => {
      console.log(`[iu] transcode step=worker-error error=${String(event.message ?? event)}`);
    });
    return sharedWorker;
  } catch (error) {
    console.log(`[iu] transcode step=worker-FAILED error=${String(error?.message ?? error)}`);
    return null;
  }
}

/**
 * Transcode what the browser cannot play, streaming into the element and keeping it fed.
 *
 * Returns as soon as the `MediaSource` exists, so the caller can attach it to the element
 * before production finishes. `done` resolves immediately because production continues in
 * the background across seeks; errors surface on the console and the element's own state.
 *
 * @param {File|Blob} file
 * @param {HTMLVideoElement} video The element being played, so seeks can be observed.
 * @param {{trackIndex?: number, onProgress?: (fraction: number) => void}} [options]
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
  let disposed = false;
  /** @type {unknown} */
  let failure = null;

  /** @type {string|null} */
  let mime = null;
  /** @type {number|null} */
  let duration = null;
  /** @type {(value: string) => void} */
  let announceMime;
  const mimeReady = new Promise((resolve) => {
    announceMime = resolve;
  });

  /** Fragments waiting to be appended, in arrival order. @type {Array<{bytes: Uint8Array, init: boolean, offset: number}>} */
  const queue = [];

  /** The pass currently expected, so chunks from a cancelled pass are dropped. */
  let activePass = 0;
  /** The offset the active pass belongs at, in source seconds. */
  let passOffset = 0;
  /** Whether the active pass has produced anything yet. */
  let passProduced = false;
  /** The source time the produced media reaches, in seconds. */
  let producedThrough = 0;
  /** The number of media fragments in the active pass, used with `minimumFragmentDuration`. */
  let passCursor = 0;
  /** When the current seek was requested, for the latency trace. */
  let seekAskedAt = 0;
  /** The last source time a seek was requested for, so a drag does not repeat it. */
  let lastSeekAt = -1;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let settleTimer = null;

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
   * Free produced media that is well behind the playhead.
   *
   * **Without this the buffer is the whole film.** For a short clip that is fine; for a
   * two-hour film it is hundreds of megabytes, and once it exceeds the platform's quota
   * the appends fail and the film wedges, because the element is not playing far enough to
   * drain. Called on `timeupdate`, cheaply.
   */
  const evict = () => {
    if (disposed || !sourceBuffer || sourceBuffer.updating || !sourceBuffer.remove) return;
    const behind = Math.max(0, video.currentTime - EVICT_BEHIND_SECONDS);
    if (behind < 1) return;
    // Only remove what is actually buffered, or the call throws for a range it does not hold.
    if (!sourceBuffer.buffered.length) return;
    if (sourceBuffer.buffered.start(0) >= behind) return;
    try {
      sourceBuffer.remove(0, behind);
    } catch {
      // A range the buffer does not hold, or a source mid-teardown. Never fatal: the
      // film plays with more memory used than intended.
    }
  };

  /**
   * Ask the worker for a pass starting at the keyframe before the target.
   *
   * @param {number} seconds
   */
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
    worker.postMessage({ type: 'seek', id: activePass, seconds });
  };

  /**
   * Act on a settled seek, rather than on every `seeking` event during a drag.
   *
   * @param {number} seconds
   */
  const settleSeek = (seconds) => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      requestSeek(seconds);
    }, SEEK_SETTLE_MS);
  };

  /**
   * React to the playhead, on `timeupdate`, `seeking` and `seeked`.
   *
   * **`seeking` is the important one.** A stall is exactly the state where `timeupdate`
   * stops firing, so a handler that only listens for `timeupdate` never gets a chance to
   * notice that the playhead jumped past what was produced: the element sits waiting, no
   * event arrives, and the seek is never asked for. `seeking` fires the moment
   * `currentTime` is written, before the wait begins.
   */
  const onPlayheadMoved = () => {
    if (disposed || sourceBuffer?.updating) return;
    if (producedThrough <= 0) return;
    // Eviction is cheap and runs on every event; a seek only when about to run dry.
    evict();
    if (video.currentTime > producedThrough - SEEK_MARGIN_SECONDS) {
      settleSeek(video.currentTime);
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
        seekAskedAt = 0;
      }
      passProduced = true;
      passCursor += 1;
      // Fragments carry no timestamp here; the pass's offset plus a running estimate of
      // its produced span is enough to know when the element will run dry.
      // `minimumFragmentDuration` is 1 second, so each fragment advances it by about one.
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
      options.onProgress?.(Math.min(1, message.fraction ?? message.progress ?? 0));
    } else if (message.type === 'error') {
      // A conversion failure means silence with no other symptom, so it is logged rather
      // than swallowed.
      failure = new Error(message.message);
      console.log(`[iu] transcode step=error message=${message.message}`);
    }
  };

  /** Push the worker's duration onto the `MediaSource`, once both are ready. */
  const applyDuration = () => {
    if (duration == null || mediaSource.readyState !== 'open') return;
    try {
      mediaSource.duration = duration;
    } catch {
      // A source that has ended, or a duration the platform rejects. Not fatal: the
      // element still plays, it simply reports its own duration.
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
          console.log(`[iu] transcode step=sourcebuffer-failed error=${String(error?.message ?? error)}`);
        }
      })();
    },
    { once: true },
  );

  // `timeupdate` for the ordinary advance and eviction; `seeking` for the jump, because
  // that is the only event that fires while the element is stalled.
  video.addEventListener('timeupdate', onPlayheadMoved);
  video.addEventListener('seeking', onPlayheadMoved);
  video.addEventListener('seeked', onPlayheadMoved);

  worker.addEventListener('message', onMessage);
  worker.postMessage({ type: 'convert', id: activePass, file, trackIndex: options.trackIndex ?? 0 });

  return {
    url,
    done: Promise.resolve(),
    revoke: () => {
      disposed = true;
      if (settleTimer) clearTimeout(settleTimer);
      video.removeEventListener('timeupdate', onPlayheadMoved);
      video.removeEventListener('seeking', onPlayheadMoved);
      video.removeEventListener('seeked', onPlayheadMoved);
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
