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
 * How much produced media to keep behind the playhead before evicting it, in seconds.
 *
 * This exists to bound a two-hour film, NOT to manage a runaway producer: the producer
 * now advances only on request and in small windows (see the worker's `WINDOW_SECONDS`),
 * so the buffer stays near what has been watched. So the margin can be modest rather
 * than the minutes it used to be, which only mattered while the producer filled the
 * buffer as fast as it could and eviction was the only thing standing between it and the
 * platform quota.
 *
 * It stays comfortably above the window size so ordinary back-and-forth within a minute
 * never forces a re-produce.
 */
const EVICT_BEHIND_SECONDS = 60;

/**
 * The runway ahead of the playhead to keep produced, in seconds: a minimum and a maximum.
 *
 * **Adaptive, so a fast machine is not starved and a slow one is not over-buffered.** The
 * producer is asked for another window whenever the playable media ahead of the playhead
 * falls below `LEAD_MIN`. `LEAD_MAX` is the ceiling that keeps a two-hour film bounded:
 * past it, no more windows are requested, so the buffer stays near what has been watched
 * and the platform never has to evict to stay inside its quota (that eviction is what the
 * runaway producer used to trigger, and what dropped the media under the playhead).
 *
 * The gap between them is the slack: a window produces five seconds (see the worker's
 * `WINDOW_SECONDS`), so the producer must be able to finish one before the runway runs
 * out. It used to be a fixed 15 with no ceiling, which is how the buffer grew unchecked.
 *
 * Both are expressed in produced seconds AHEAD of the playhead rather than a fixed lead,
 * so they hold at 0.5x (the buffer drains twice as fast, so `LEAD_MIN` is more urgent) and
 * at 1.25x without a rate term anywhere.
 */
const LEAD_MIN = 12;
const LEAD_MAX = 40;

/**
 * How long a seek must be quiet before it is acted on, in milliseconds.
 *
 * Dragging a scrubber fires many `seeking` events a second. Acting on each one would
 * cancel a pass faster than it can start, so nothing would ever complete. This lets the
 * drag settle and acts on where it stopped.
 */
const SEEK_SETTLE_MS = 200;

/**
 * How far the playhead must move from the last requested position before a re-seek.
 *
 * A pass is produced from a keyframe before its requested position and covers forward from
 * there, so the playhead sitting near that position is covered by the pass even while the
 * first fragment is still arriving. Only a move beyond this means the playhead is somewhere
 * the in-flight pass does not serve. Small enough that an ordinary seek is immediate, large
 * enough that jitter around the position does not cancel the pass.
 */
const RESEEK_MARGIN_SECONDS = 1;

/**
 * How often the watchdog re-checks the runway while the element is playing, in ms.
 *
 * **A safety net, and it exists because a lost wakeup stopped playback dead.** Production
 * is otherwise driven by events (`updateend`, the playhead events), which is efficient but
 * means a single missed signal leaves the element with nothing to play and no further event
 * to notice it by. This ticks while playing and re-asks for a window whenever the runway is
 * short, so a missed signal costs at most one tick rather than the rest of the film.
 */
const WATCHDOG_MS = 750;

/**
 * How long the producer must make no progress before the playhead is treated as stuck.
 *
 * Generous on purpose. A cold pass delivers its first fragment in about 400 ms on a large
 * file, and a machine under load can take several seconds. Re-seeking before that CANCELS
 * the pass that was about to succeed, which is a loop rather than a recovery, so the
 * threshold must be comfortably longer than a slow-but-healthy start.
 */
const STALL_MS = 8000;

/**
 * How long to wait for the FIRST fragment before trying the seek again.
 *
 * Longer than `STALL_MS`, because a pass has to be set up (a keyframe lookup, the coder,
 * the first window) before it can produce anything, and a false re-seek at startup is what
 * wedged a short file that was never actually stuck. Only a pass that has produced NOTHING
 * for this long is re-issued.
 */
const SEED_STALL_MS = 15000;

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
  /** When the current seek was requested, for the latency trace. */
  let seekAskedAt = 0;
  /**
   * When the producer last made progress: media appended, or a pass just requested.
   *
   * **A re-seek is only allowed once progress has genuinely stopped.** A pass takes a
   * moment to deliver its first fragment (about 400 ms on a large cold seek, longer on a
   * busy machine), and the element is legitimately unbuffered during that window. Seeking
   * again then CANCELS the pass before it can produce, which is an infinite loop: the
   * startup case did exactly this, re-seeking at 0 forever so nothing ever appended. So
   * every "the buffer is empty" decision is measured against this, and only a pass that
   * has produced nothing for `STALL_MS` is treated as stuck.
   */
  let lastProgressAt = 0;
  /** The last source time a seek was requested for, so a drag does not repeat it. */
  let lastSeekAt = -1;
  /**
   * Whether the emergency seek-to-start has already run.
   *
   * **Once per file, so it cannot become a loop.** The start is always produceable, so if
   * even that fails to fill the buffer, seeking to it again would loop; a single attempt to
   * reach a knowable place is the promise, not infinite retrying of the same place.
   */
  let startFallbackTried = false;
  /**
   * The `producedMedia` count when the active pass was requested.
   *
   * **This is what stops an infinite seek loop.** A seek must not be re-issued until the
   * pass it just started has had a chance to deliver media; without this, the watchdog saw
   * the element still unbuffered (the previous passes filled elsewhere) and re-seeked
   * every few hundred milliseconds, so the seek was cancelled and restarted forever and
   * never appended anything. The count is `producedMedia` at request time, so "no progress
   * since the request" is a real stall rather than a slow start.
   */
  let pendingSinceCount = -1;
  /** Whether the whole file has been produced, so no more windows are requested. */
  let producerDone = false;
  /**
   * How many media chunks the active pass has actually APPENDED.
   *
   * Used with `pendingSinceCount` to tell "this pass has not started yet" from "this pass
   * is stuck": a chunk was appended since the seek was requested only if this grew.
   */
  let producedMedia = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let settleTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let watchdogTimer = null;

  /**
   * Whether the element has media buffered at a source time.
   *
   * **This replaces the estimate that caused the hang.** The bridge used to decide
   * whether it needed to produce more from a running count of fragments, which said "I
   * already produced past here" even after the platform had EVICTED that region to stay
   * under its quota. So a backward seek into an evicted region was judged unnecessary and
   * never refilled, and the element starved. The element's `buffered` ranges are the
   * ground truth: a time inside one is playable, a time outside one is not, whatever we
   * think we produced.
   *
   * @param {number} seconds
   * @returns {boolean}
   */
  const isBuffered = (seconds) => {
    if (!sourceBuffer) return false;
    const ranges = sourceBuffer.buffered;
    for (let i = 0; i < ranges.length; i++) {
      // A hair inside the edges, so a time exactly on a boundary counts as buffered.
      if (seconds >= ranges.start(i) - 0.05 && seconds <= ranges.end(i) + 0.05) return true;
    }
    return false;
  };

  /**
   * The end of the CONTIGUOUS run of buffered media containing, or nearest ahead of, a time.
   *
   * **The furthest buffer end is the wrong measure, and it is what broke a spammed
   * backward seek.** The element's `buffered` is a list of disjoint ranges. After seeking
   * backward the list holds the range being rebuilt AND the range that was there before,
   * further ahead, so the FURTHEST end reported a large runway while the playhead actually
   * had almost none. The producer was then paused (`requestPause` saw a huge "ahead") and
   * the buffer never grew past the first fragment, so playback crawled.
   *
   * The runway that matters is the media the playhead can reach WITHOUT a gap, so this
   * walks the ranges from the one covering `seconds` and stops at the first gap. A time
   * before all ranges returns the start of the first, which reads as "no runway yet".
   *
   * @param {number} seconds
   * @returns {number}
   */
  const bufferedAheadEnd = (seconds) => {
    if (!sourceBuffer) return 0;
    const ranges = sourceBuffer.buffered;
    if (!ranges.length) return 0;
    let end = -Infinity;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) > seconds + 0.05) {
        // The first range ahead of the playhead: only it can extend the runway, and only if
        // it touches what we already had.
        return end === -Infinity ? ranges.start(i) : end;
      }
      // Touching or covering the playhead: extend the runway to this range's end.
      if (ranges.start(i) <= seconds + 0.05 && ranges.end(i) >= seconds - 0.05) end = ranges.end(i);
      else if (end !== -Infinity && ranges.start(i) <= end + 0.05) end = ranges.end(i);
    }
    return end === -Infinity ? ranges.start(0) : end;
  };

  /**
   * Ask the producer to keep going, because the playhead is running out of runway.
   *
   * The condition is "less than `LEAD_MAX` of playable media ahead", measured from the
   * element's buffer, so it is correct however much the platform has evicted. The producer
   * is otherwise paused (`requestPause`), so this is what keeps it just ahead.
   */
  const requestMore = () => {
    if (disposed || producerDone) return;
    if (bufferedAheadEnd(video.currentTime) - video.currentTime < LEAD_MAX) worker.postMessage({ type: 'produce', id: activePass });
  };

  /**
   * Tell the producer to hold, because there is already a comfortable runway.
   *
   * **The upper half of the adaptive target, and the reason the buffer stays bounded.**
   * Without it the producer runs as fast as it can and the buffer grows until the platform
   * evicts the oldest range to stay inside its quota, which drops media under the playhead.
   * Pausing above `LEAD_MAX` keeps the lead between `LEAD_MIN` and `LEAD_MAX`, so a two-hour
   * film costs about a minute of buffer rather than the whole file.
   */
  const requestPause = () => {
    if (disposed || producerDone) return;
    if (bufferedAheadEnd(video.currentTime) - video.currentTime > LEAD_MAX) worker.postMessage({ type: 'pause', id: activePass });
  };

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
   * **Sent whenever the target is NOT already playable**, whatever direction it is.
   * Nothing here decides "we have already produced past this", because that is the
   * decision that broke the backward seek: the region it judged produced had been evicted.
   * A target that is buffered is not sought at all (see `onPlayheadMoved`), so arriving
   * here means a pass is genuinely needed.
   *
   * @param {number} seconds
   */
  const requestSeek = (seconds) => {
    lastSeekAt = seconds;
    lastProgressAt = Date.now();
    activePass += 1;
    passOffset = seconds;
    producerDone = false;
    seekAskedAt = Date.now();
    /** The index to clear once this pass has appended its first media, or -1 before it has. @type {number} */
    pendingSinceCount = -1;
    worker.postMessage({ type: 'seek', id: activePass, seconds });
  };

  /**
   * Act on a settled seek, rather than on every `seeking` event during a drag.
   *
   * @param {number} seconds
   */
  const settleSeek = (seconds) => {
    // Reset the buffer position expectations for the new pass: `updateend` will request
    // more, so appending resumes without any explicit kick.
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
   * notice that the playhead jumped outside the buffer: the element sits waiting, no event
   * arrives, and the seek is never asked for. `seeking` fires the moment `currentTime` is
   * written, before the wait begins.
   *
   * The test is the element's OWN buffer, not a producer estimate, so it holds in both
   * directions and after an eviction.
   */
  const onPlayheadMoved = () => {
    if (disposed || sourceBuffer?.updating) return;
    // Eviction is cheap and runs on every event.
    evict();
    if (isBuffered(video.currentTime)) {
      // The playhead is fine; just keep enough runway ahead of it.
      requestMore();
      return;
    }
    // **The playhead is outside the buffer, but that alone does not mean a seek.** At
    // startup the buffer is empty and `timeupdate` fires at 0 while the first pass is
    // still being produced; seeking again there would cancel the very pass that is about
    // to fill it. That was an infinite loop at 0. A seek is only right when the playhead
    // has moved somewhere the in-flight pass does not start at, so the last requested
    // position is the reference.
    if (Math.abs(video.currentTime - lastSeekAt) > RESEEK_MARGIN_SECONDS) settleSeek(video.currentTime);
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
      if (seekAskedAt) {
        console.log(`[iu] transcode step=seek-first-fragment ms=${Date.now() - seekAskedAt}`);
        seekAskedAt = 0;
      }
      producedMedia += 1;
      lastProgressAt = Date.now();
      // This pass has delivered media, so a later stall is not "waiting for the first
      // fragment" and may be re-issued. See `pendingSinceCount`.
      pendingSinceCount = -1;
      queue.push({ bytes: message.bytes, init: false, offset: message.offset ?? passOffset });
      pump();
      return;
    }
    if (message.type === 'paused') {
      // The producer suspended itself (the bridge asked, or its wait watchdog fired). If
      // the runway has since shrunk, ask it to resume; otherwise leave it held.
      requestMore();
      return;
    }
    if (message.type === 'mime') {
      mime = message.mime;
      duration = message.duration;
      announceMime(mime);
      applyDuration();
    } else if (message.type === 'progress') {
      options.onProgress?.(Math.min(1, message.fraction ?? message.progress ?? 0));
    } else if (message.type === 'done') {
      producerDone = true;
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

  const onUpdateEnd = () => {
    // A completed append is the moment the buffer changed, so it is the moment to decide
    // whether the producer should continue or hold. Doing it here rather than on a timer
    // means production is driven by playback progress and not by the clock.
    pump();
    const ahead = bufferedAheadEnd(video.currentTime) - video.currentTime;
    if (ahead > LEAD_MAX) requestPause();
    else if (ahead < LEAD_MAX) requestMore();
  };

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
          // The element is ready, so let the producer start running. It begins paused in
          // effect, waiting for this first `produce`.
          requestMore();
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

  // The watchdog: while playing, re-check the runway so a missed signal cannot strand the
  // element with nothing to play. It only asks when the runway is genuinely short, so it
  // adds no production of its own. See `WATCHDOG_MS`.
  watchdogTimer = setInterval(() => {
    if (disposed || video.paused) return;
    if (!isBuffered(video.currentTime)) {
      // **Stalled outside the buffer.** Recovery is gated on the producer having made NO
      // progress at all for a while, never on "the buffer is empty right now", because an
      // empty buffer at startup or during a cold seek is normal and re-seeking then would
      // cancel the very pass that is about to fill it. `waitingForFirst` distinguishes a
      // pass that has not delivered yet (long patience) from one that delivered and then
      // went quiet (shorter patience).
      const waited = Date.now() - lastProgressAt;
      const waitingForFirst = pendingSinceCount >= 0 && producedMedia === pendingSinceCount;
      const limit = waitingForFirst ? SEED_STALL_MS : STALL_MS;
      if (waited > limit) {
        if (!startFallbackTried && video.currentTime > 5) {
          startFallbackTried = true;
          console.log(`[iu] transcode step=stuck-fallback from=${video.currentTime.toFixed(1)}`);
          requestSeek(0);
          return;
        }
        console.log(`[iu] transcode step=stuck-retry t=${video.currentTime.toFixed(1)}`);
        requestSeek(video.currentTime);
        return;
      }
      // Not stuck yet, but if this is a fresh position outside the buffer, make sure a
      // pass is on its way; `settleSeek` debounces so a drag does not cancel per event.
      if (!settleTimer && !waitingForFirst && waited < 500) settleSeek(video.currentTime);
      return;
    }
    // A runway BELOW the minimum means the producer could not keep up with playback, which
    // is what an underrun sounds like (a stutter). Logged so it is visible in a paste
    // rather than only felt, and the ask below is what recovers it.
    const ahead = bufferedAheadEnd(video.currentTime) - video.currentTime;
    if (ahead < LEAD_MIN) console.log(`[iu] transcode step=underrun ahead=${ahead.toFixed(1)}`);
    if (ahead > LEAD_MAX) requestPause();
    else requestMore();
  }, WATCHDOG_MS);

  worker.addEventListener('message', onMessage);
  // A pending pass from the start, so the watchdog treats the initial production as "not
  // delivered yet" rather than "stuck", which is what stops it re-seeking at 0 before the
  // first window has had a chance to arrive.
  pendingSinceCount = producedMedia;
  lastSeekAt = 0;
  lastProgressAt = Date.now();
  worker.postMessage({ type: 'convert', id: activePass, file, trackIndex: options.trackIndex ?? 0 });

  return {
    url,
    done: Promise.resolve(),
    revoke: () => {
      disposed = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
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
