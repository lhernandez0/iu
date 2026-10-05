/**
 * YouTube content script — runs in the ISOLATED world.
 *
 * This is a FETCH PROVIDER, not the owner of anything. The service worker holds
 * the transcript table and decides what is wanted; this script:
 *   1. Asks the MAIN-world page bridge for the player response (see
 *      page-bridge.js for why that indirection is necessary).
 *   2. Fetches and parses caption tracks on request.
 *   3. Reports the active segment as the video plays.
 *   4. Reports SPA navigation.
 *
 * It keeps no cross-request cache: the part of a track that embeds the video id
 * has a limited lifetime, so tracks are fetched, handed to the worker, and
 * dropped. Any extra fetch costs one HTTP request and keeps stale state
 * impossible.
 *
 * Injected as a CLASSIC script (content scripts cannot use `import`), so the
 * message names below duplicate src/common/messages.js and the segment helpers
 * duplicate src/common/transcript.js. Keep them in step.
 */

(() => {
  // --- Re-entry guard ------------------------------------------------------
  // The worker injects this file on demand with chrome.scripting, which re-runs
  // it even when a copy is already live on the page. Without this guard each
  // injection would add another position-reporting interval.
  if (window.__iuContentLoaded) return;
  window.__iuContentLoaded = true;

  // --- Duplicated contract -------------------------------------------------
  const CHANNEL = 'iu-ext';
  const MSG = {
    DESCRIBE: 'describe',
    PROVIDE: 'provide',
    FETCH_TRACK: 'fetch-track',
    CONTENT_SEEK: 'content-seek',
    CONTENT_POSITION: 'content-position',
    CONTENT_VIDEO_CHANGED: 'content-video-changed',
  };
  const TARGET = { BACKGROUND: 'background', CONTENT: 'content' };

  const POSITION_POLL_MS = 250;
  /** How often to ask the page whether the video changed. One second is often
   *  enough that a switch feels instant, and cheap enough to run continuously. */
  const VIDEO_CHECK_MS = 1000;

  /**
   * Tracks for the video currently loaded here. Rebuilt on every PROVIDE, and
   * replaced wholesale when the page navigates.
   *
   * @type {{videoId: string|null, title: string|null, isLive: boolean,
   *         tracks: object[], segments: object[]|null}}
   */
  let video = {
    videoId: null,
    title: null,
    isLive: false,
    tracks: [],
    translationLanguages: [],
    segments: null,
    needsInnertube: false,
  };
  let lastActiveIndex = -2;

  /** Interval handles, so they can all be stopped at once. @type {number[]} */
  const timers = [];

  // --- Page bridge ---------------------------------------------------------

  let nextRequestId = 0;
  const pending = new Map();

  /**
   * @param {string} type
   * @returns {Promise<object|null>} The bridge's payload, or null on failure.
   */
  function askBridge(type) {
    const requestId = `${Date.now()}-${nextRequestId++}`;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      window.postMessage({ channel: CHANNEL, direction: 'request', requestId, type }, window.location.origin);
      // The bridge is tiny and synchronous; if it hasn't answered in a moment
      // it is not going to.
      setTimeout(() => {
        if (pending.delete(requestId)) resolve(null);
      }, 2000);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;

    if (data.direction === 'response' && pending.has(data.requestId)) {
      const resolve = pending.get(data.requestId);
      pending.delete(data.requestId);
      resolve(data.ok ? data.payload : null);
      return;
    }

    if (data.direction === 'event' && data.type === 'navigated') {
      // Single-page app navigation. Do not discard the cached tracks here — the
      // worker decides whether the video actually changed, and re-requesting
      // on every navigation event would refetch needlessly.
      post({ type: MSG.CONTENT_VIDEO_CHANGED, target: TARGET.BACKGROUND });
    }
  });

  // --- Transcript ----------------------------------------------------------

  /** @returns {HTMLVideoElement|null} */
  function getVideo() {
    return document.querySelector('video');
  }

  /** @returns {number} */
  function getPosition() {
    return getVideo()?.currentTime ?? 0;
  }

  /**
   * Parse YouTube's timedtext response.
   *
   * We ask for JSON3 (`fmt=json3`), but a track that does not support it
   * answers with XML anyway, so both shapes are handled. XML is also the
   * format jdepoix/youtube-transcript-api documents.
   *
   * @param {string} body
   * @returns {object[]} Segments.
   */
  function parseTimedText(body) {
    const text = body.trim();
    if (!text) return [];

    // --- JSON3: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] } ---
    if (text.startsWith('{')) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return [];
      }
      return (json.events ?? [])
        .filter((event) => Array.isArray(event.segs))
        .map((event) => ({
          start: (event.tStartMs ?? 0) / 1000,
          duration: (event.dDurationMs ?? 0) / 1000,
          text: event.segs.map((seg) => seg.utf8 ?? '').join(''),
        }))
        .map((segment) => ({ ...segment, text: segment.text.replace(/\n/g, ' ').trim() }))
        .filter((segment) => segment.text.length > 0);
    }

    // --- XML: <transcript><text start="0" dur="1.54">…</text></transcript> ---
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    return [...doc.querySelectorAll('text')]
      .map((node) => {
        const start = Number.parseFloat(node.getAttribute('start') ?? '0');
        const duration = Number.parseFloat(node.getAttribute('dur') ?? '0');
        // textContent decodes the entities YouTube emits (&amp;#39; etc).
        const value = (node.textContent ?? '').replace(/\n/g, ' ').trim();
        return { start: Number.isFinite(start) ? start : 0, duration: Number.isFinite(duration) ? duration : 0, text: value };
      })
      .filter((segment) => segment.text.length > 0);
  }

  /**
   * Force the response format and optionally a translation language.
   *
   * @param {string} baseUrl
   * @param {string|null} translateTo
   * @returns {string}
   */
  function buildTrackUrl(baseUrl, translateTo) {
    try {
      const url = new URL(baseUrl, window.location.origin);
      url.searchParams.set('fmt', 'json3');
      if (translateTo) url.searchParams.set('tlang', translateTo);
      return url.toString();
    } catch {
      return baseUrl;
    }
  }

  /**
   * Fetch a caption track. Primary path is a plain fetch from the page's own
   * origin, which carries the session's cookies. If YouTube refuses that
   * (jdepoix documents them blocking the embedded URL for server-side
   * callers), fall back to the internal player API.
   *
   * @param {object} track
   * @param {string} videoId
   * @param {string|null} innertubeApiKey
   * @param {string|null} translateTo
   * @returns {Promise<object[]>}
   */
  async function fetchSegments(track, videoId, innertubeApiKey, translateTo) {
    const url = buildTrackUrl(track.baseUrl, translateTo);

    const direct = await fetch(url, { credentials: 'include' }).catch(() => null);
    if (direct?.ok) {
      const body = await direct.text();
      if (body.trim()) return parseTimedText(body);
    }

    // --- Fallback: INNERTUBE ------------------------------------------------
    // Re-ask the internal player API for the track list, which hands back a
    // freshly signed baseUrl that is valid for this session.
    if (!innertubeApiKey || !videoId) return [];

    const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${innertubeApiKey}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } },
        videoId,
      }),
    }).catch(() => null);
    if (!response?.ok) return [];

    const fresh = await response.json().catch(() => null);
    const tracks = fresh?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    // Prefer the same language we wanted; otherwise take the first track.
    const match = tracks.find((t) => t.languageCode === track.languageCode) ?? tracks[0];
    if (!match?.baseUrl) return [];

    const retry = await fetch(buildTrackUrl(match.baseUrl, translateTo), { credentials: 'include' }).catch(() => null);
    if (!retry?.ok) return [];
    return parseTimedText(await retry.text());
  }

  /**
   * Fetch a track by language, optionally translated.
   *
   * A translation is not a separate track on YouTube: it is the SAME track's
   * baseUrl with `&tlang=` added, so the cue timings are byte-for-byte the same
   * and only the text differs. That is why this composes with alignment and
   * seeking for free, and why one function covers both.
   *
   * The returned `languageCode` is the SOURCE track's code, never the target.
   * The worker keys its cache and its rows by the source track, and reports the
   * target separately, so a translated track is "en, translated into ja" rather
   * than becoming an `ja` track that would collide with a real Japanese one.
   *
   * @param {string} languageCode Source track.
   * @param {string|null} [translateTo]
   * @returns {Promise<{languageCode: string, translateTo: string|null, segments: object[], error: string|null}>}
   */
  async function fetchTrack(languageCode, translateTo = null) {
    const summary = await askBridge('get-player-response');

    // After an in-tab navigation the page's track list belongs to the previous
    // video, so it cannot be used: its URLs point at the wrong captions. The
    // internal player API has to be asked for this video's tracks instead.
    if (!summary || summary.stale) {
      return fetchTrackViaInnertube(languageCode, translateTo);
    }

    const track = summary.tracks.find((t) => t.languageCode === languageCode) ?? summary.tracks[0];
    if (!track) return fetchTrackViaInnertube(languageCode, translateTo);

    // Only some tracks carry translations. Asking anyway returns the untranslated
    // text, which would be silently wrong — a "Japanese" line that is actually
    // English. Better to say so.
    if (translateTo && !track.isTranslatable) {
      return {
        languageCode: track.languageCode,
        translateTo: null,
        segments: [],
        error: 'This caption track cannot be auto-translated.',
      };
    }

    try {
      const segments = await fetchSegments(track, summary.videoId, summary.innertubeApiKey, translateTo);
      return {
        languageCode: track.languageCode,
        translateTo: translateTo ?? null,
        segments,
        error: segments.length ? null : 'The caption track came back empty.',
      };
    } catch (error) {
      return { languageCode, translateTo: null, segments: [], error: `Could not load captions: ${error?.message ?? error}` };
    }
  }

  /**
   * Resolve a track by re-asking the internal player API.
   *
   * This is the fallback path jdepoix/youtube-transcript-api documents, and it
   * earns its place here for a different reason: it is the only way to get the
   * RIGHT tracks when the page's cached player response is stale, which is the
   * normal state after switching video inside a tab.
   *
   * @param {string} languageCode
   * @param {string|null} [translateTo]
   * @returns {Promise<{languageCode: string, translateTo: string|null, segments: object[], error: string|null}>}
   */
  async function fetchTrackViaInnertube(languageCode, translateTo = null) {
    // This can be reached without a prior sync — the worker asks for a specific
    // track on its own — so make sure we know which video we are asking about.
    if (!video.videoId) await sync();

    const summary = await askBridge('get-player-response');
    const key = summary?.innertubeApiKey ?? null;

    if (!key || !video.videoId) {
      return { languageCode, translateTo: null, segments: [], error: 'Could not read this video captions.' };
    }

    const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } },
        videoId: video.videoId,
      }),
    }).catch(() => null);

    if (!response?.ok) return { languageCode, translateTo: null, segments: [], error: 'Could not reach the player API.' };

    const fresh = await response.json().catch(() => null);
    const tracks = fresh?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    if (!tracks.length) return { languageCode, translateTo: null, segments: [], error: 'This video has no captions.' };

    const track = tracks.find((t) => t.languageCode === languageCode) ?? tracks[0];
    if (translateTo && !track.isTranslatable) {
      return {
        languageCode: track.languageCode,
        translateTo: null,
        segments: [],
        error: 'This caption track cannot be auto-translated.',
      };
    }

    try {
      const segments = await fetchSegments(track, video.videoId, key, translateTo);
      return {
        languageCode: track.languageCode,
        translateTo: translateTo ?? null,
        segments,
        error: segments.length ? null : 'The caption track came back empty.',
      };
    } catch (error) {
      return { languageCode, translateTo: null, segments: [], error: `Could not load captions: ${error?.message ?? error}` };
    }
  }

  /**
   * Prefer a human-authored track over machine-generated ones, and English
   * over anything else — the same default ordering YouTube's own panel uses.
   *
   * @param {object[]} tracks
   * @returns {object|undefined}
   */
  function pickDefaultTrack(tracks) {
    const manual = tracks.filter((t) => t.kind !== 'asr');
    return (
      manual.find((t) => t.languageCode?.startsWith('en')) ??
      manual[0] ??
      tracks.find((t) => t.languageCode?.startsWith('en')) ??
      tracks[0]
    );
  }

  /**
   * Re-read the page and hand back the current video plus the requested track.
   *
   * Recording the segments here is what lets position reporting work without the
   * worker having to tell us about them.
   *
   * @param {string|null} languageCode Which track to load, or null for the default.
   * @param {string|null} [translateTo] Target language, or null for the original text.
   * @returns {Promise<object>} A PROVIDE payload.
   */
  async function provide(languageCode, translateTo = null) {
    const result = await sync();
    if (!result.ok) return { ok: false, error: result.error, video: describeVideo() };

    // Go through the player API when the page cannot be trusted: either its
    // track list belongs to the previous video (stale), or it has no player
    // data at all. In both cases we still know the video id from the URL, which
    // is all the player API needs.
    if (result.stale || !video.tracks.length) {
      const fetched = await fetchTrackViaInnertube(languageCode ?? 'en', translateTo);
      // Only record the segments when they are the ones the worker will render.
      // A failed translation returns an empty list, and storing that would blank
      // the transcript it was only supposed to translate.
      if (fetched.segments.length) {
        video.segments = fetched.segments;
        return { ok: true, video: describeVideo(), requested: fetched.languageCode, fetched };
      }
      return { ok: false, error: fetched.error, video: describeVideo(), fetched };
    }

    const wanted = languageCode ? video.tracks.find((t) => t.languageCode === languageCode) : null;
    const track = wanted ?? pickDefaultTrack(video.tracks);
    const fetched = await fetchTrack(track.languageCode, translateTo);
    if (fetched.segments.length) video.segments = fetched.segments;

    return { ok: true, video: describeVideo(), requested: track.languageCode, fetched };
  }

  /**
   * Ask the page which video is loaded, and adopt it if it changed.
   *
   * This, not the page's navigation events, is the authority on which video this
   * script is looking at. YouTube's SPA events are unreliable — switching video
   * within a tab does not always fire one the content script hears — and the
   * failure is ugly: the script would keep reporting the previous video's cues
   * while reading the new video's currentTime, so the panel would show the old
   * transcript advancing against the new video.
   *
   * @returns {Promise<{ok: boolean, changed: boolean, stale: boolean, error?: string}>}
   */
  async function sync() {
    const summary = await askBridge('get-player-response');
    if (!summary) {
      const changed = video.videoId !== null;
      video = {
        videoId: null,
        title: null,
        isLive: false,
        tracks: [],
        translationLanguages: [],
        segments: null,
        needsInnertube: false,
      };
      lastActiveIndex = -2;
      return { ok: false, changed, stale: false, error: 'This page has no video player.' };
    }

    const changed = video.videoId !== summary.videoId;
    if (changed) {
      // Whatever we were reporting belongs to the previous video.
      video.segments = null;
      lastActiveIndex = -2;
    }

    // A stale track list is the previous video's. Keep it out of `video.tracks`
    // so it can never be fetched, but remember that captions still need
    // resolving through the internal player API for this video.
    video = {
      videoId: summary.videoId,
      title: summary.title,
      isLive: summary.isLive,
      tracks: summary.stale ? [] : summary.tracks,
      translationLanguages: summary.stale ? [] : (summary.translationLanguages ?? []),
      segments: video.segments,
      needsInnertube: Boolean(summary.stale),
    };

    return { ok: true, changed, stale: Boolean(summary.stale) };
  }

  /** @returns {object} Video identity plus the track list the panel can offer. */
  function describeVideo() {
    return {
      videoId: video.videoId,
      title: video.title,
      isLive: video.isLive,
      // True when the page's own track list belongs to a different video and so
      // has been withheld. The worker uses this to tell "captions unreadable"
      // apart from "this video has none", which look identical otherwise.
      stale: Boolean(video.needsInnertube),
      // Reported with the description because the position poll only fires on a
      // CHANGE. If the worker restarts while this script keeps running, it would
      // otherwise never hear where playback is — and a panel opened mid-video
      // would sit at the top of the transcript.
      activeIndex: video.segments?.length ? findActiveIndex(video.segments, getPosition()) : null,
      trackList: video.tracks.map((t) => ({
        languageCode: t.languageCode,
        name: t.name,
        kind: t.kind,
        isTranslatable: Boolean(t.isTranslatable),
      })),
      // Which languages this video can be translated into. The panel offers
      // these rather than a built-in list, so it can never drift from what
      // YouTube will actually serve.
      translationLanguages: video.translationLanguages ?? [],
    };
  }

  // --- Service-worker requests ---------------------------------------------

  /**
   * Answer the worker, tolerating a context that died mid-request.
   *
   * Every branch below answers asynchronously, so the extension can be reloaded
   * while a caption fetch is in flight — and `sendResponse` then throws the same
   * invalidation error, from inside a promise, where nothing is listening for it.
   *
   * @param {Function} sendResponse
   * @param {object} payload
   */
  function reply(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch {
      teardown();
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== TARGET.CONTENT) return false;

    switch (message.type) {
      case MSG.DESCRIBE:
        sync()
          .then((result) => reply(sendResponse, { ok: result.ok, error: result.error, video: describeVideo() }))
          .catch((error) => reply(sendResponse, { ok: false, error: String(error?.message ?? error) }));
        return true; // async reply

      case MSG.PROVIDE:
        provide(message.languageCode ?? null, message.translateTo ?? null)
          .then((payload) => reply(sendResponse, payload))
          .catch((error) => reply(sendResponse, { ok: false, error: String(error?.message ?? error) }));
        return true;

      case MSG.FETCH_TRACK:
        fetchTrack(message.languageCode, message.translateTo ?? null)
          .then((payload) => reply(sendResponse, payload))
          .catch((error) =>
            reply(sendResponse, {
              languageCode: message.languageCode,
              translateTo: null,
              segments: [],
              error: String(error?.message ?? error),
            }),
          );
        return true;

      case MSG.CONTENT_SEEK: {
        const element = getVideo();
        if (element && Number.isFinite(message.seconds)) element.currentTime = message.seconds;
        reply(sendResponse, { ok: Boolean(element) });
        return false;
      }

      default:
        return false;
    }
  });

  /**
   * Whether this script's extension context is still usable.
   *
   * When the extension is reloaded or updated, content scripts already running
   * in open tabs are orphaned: `chrome.runtime` survives as an object but loses
   * its id, and every call into it throws "Extension context invalidated." A
   * YouTube tab left open across a reload therefore keeps running this script
   * against a dead context — and the result is not one error but an endless
   * stream of them, because both polling loops keep waking.
   *
   * Reading the id is cheap and, unlike the calls it guards, does not throw.
   *
   * @returns {boolean}
   */
  function contextAlive() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * Stop everything this script is doing, once its context has gone.
   *
   * Clearing the intervals is the important part: without it both loops keep
   * waking and keep throwing, and nothing can silence them. Chrome does not
   * re-inject into pages that were already open, so there is nothing to recover
   * — the tab has to be reloaded, and this says so once rather than failing
   * forever.
   */
  function teardown() {
    if (!timers.length) return; // already down; do not warn twice
    for (const handle of timers) clearInterval(handle);
    timers.length = 0;

    // Free the page for a fresh copy. Whether a later injection can SEE this
    // depends on how Chrome handles isolated worlds across an extension reload,
    // so the tab may still need reloading — but if the flag is shared, the
    // worker's next injection takes the page back instead of being skipped by
    // the re-entry guard as though a live copy were still here.
    try {
      window.__iuContentLoaded = false;
    } catch {
      /* nothing left to do if even this is refused */
    }

    console.warn('[IU] The extension was reloaded or updated. Reload this tab to reconnect.');
  }

  /** @param {object} payload */
  function post(payload) {
    if (!contextAlive()) {
      teardown();
      return;
    }

    try {
      // No receiver is a normal state, not a failure: the worker stops when
      // idle, and it is not this script's job to restart it.
      chrome.runtime.sendMessage(payload)?.catch(() => {});
    } catch {
      // Thrown synchronously when the context died between the check and here.
      teardown();
    }
  }

  // --- Watching the page -----------------------------------------------------
  //
  // Two loops, because they answer different questions and want different rates:
  //
  //   1. Has this tab moved to a different video? Polled every second against
  //      the page. Cheap (one bridge message, no fetch) but it is the only
  //      reliable way to notice — YouTube's own navigation events do not always
  //      fire on an in-tab video switch, and missing one means the panel shows
  //      the previous video's transcript.
  //   2. Which cue is playing? Reported only when the active cue changes.

  let lastVideoIdCheck = 0;

  timers.push(
    setInterval(() => {
      // Stop before doing any work. An orphaned script has nothing left to talk
      // to, and reporting that forever is what fills the console.
      if (!contextAlive()) return teardown();

      const now = Date.now();
      if (now - lastVideoIdCheck < VIDEO_CHECK_MS) return;
      lastVideoIdCheck = now;

      void (async () => {
        const before = video.videoId;
        await sync();
        // Announce it ourselves rather than waiting to be asked, so the panel
        // corrects itself even when the user is not touching it.
        if (video.videoId !== before) {
          post({ type: MSG.CONTENT_VIDEO_CHANGED, target: TARGET.BACKGROUND });
        }
      })();
    }, VIDEO_CHECK_MS),
  );

  timers.push(
    setInterval(() => {
      if (!contextAlive()) return teardown();
      if (!video.segments?.length) return;
      const seconds = getPosition();
      const index = findActiveIndex(video.segments, seconds);
      if (index === lastActiveIndex) return;
      lastActiveIndex = index;
      post({ type: MSG.CONTENT_POSITION, target: TARGET.BACKGROUND, index, seconds });
    }, POSITION_POLL_MS),
  );

  /** Mirrors findActiveIndex in src/common/transcript.js. @returns {number} */
  function findActiveIndex(segments, seconds) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (seconds >= segments[i].start) {
        const end = segments[i].start + (segments[i].duration || 0);
        return seconds <= end || i === segments.length - 1 ? i : -1;
      }
    }
    return -1;
  }

  // Deliberately nothing at load: the worker asks for a PROVIDE only when a
  // panel is open and needs data, so an idle tab stays idle.
})();
