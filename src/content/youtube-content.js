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
  if (window.__transcribeContentLoaded) return;
  window.__transcribeContentLoaded = true;

  // --- Duplicated contract -------------------------------------------------
  const CHANNEL = 'transcribe-ext';
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
  let video = { videoId: null, title: null, isLive: false, tracks: [], segments: null, needsInnertube: false };
  let lastActiveIndex = -2;

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
   * Fetch a track by language. Returns a plain result object rather than
   * touching shared state, so one request cannot corrupt another.
   *
   * @param {string} languageCode
   * @returns {Promise<{languageCode: string, segments: object[], error: string|null}>}
   */
  async function fetchTrack(languageCode) {
    const summary = await askBridge('get-player-response');

    // After an in-tab navigation the page's track list belongs to the previous
    // video, so it cannot be used: its URLs point at the wrong captions. The
    // internal player API has to be asked for this video's tracks instead.
    if (!summary || summary.stale) {
      return fetchTrackViaInnertube(languageCode);
    }

    const track = summary.tracks.find((t) => t.languageCode === languageCode) ?? summary.tracks[0];
    if (!track) return fetchTrackViaInnertube(languageCode);

    try {
      const segments = await fetchSegments(track, summary.videoId, summary.innertubeApiKey, null);
      return {
        languageCode: track.languageCode,
        segments,
        error: segments.length ? null : 'The caption track came back empty.',
      };
    } catch (error) {
      return { languageCode, segments: [], error: `Could not load captions: ${error?.message ?? error}` };
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
   * @returns {Promise<{languageCode: string, segments: object[], error: string|null}>}
   */
  async function fetchTrackViaInnertube(languageCode) {
    // This can be reached without a prior sync — the worker asks for a specific
    // track on its own — so make sure we know which video we are asking about.
    if (!video.videoId) await sync();

    const summary = await askBridge('get-player-response');
    const key = summary?.innertubeApiKey ?? null;

    if (!key || !video.videoId) {
      return { languageCode, segments: [], error: 'Could not read this video captions.' };
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

    if (!response?.ok) return { languageCode, segments: [], error: 'Could not reach the player API.' };

    const fresh = await response.json().catch(() => null);
    const tracks = fresh?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    if (!tracks.length) return { languageCode, segments: [], error: 'This video has no captions.' };

    const track = tracks.find((t) => t.languageCode === languageCode) ?? tracks[0];
    try {
      const segments = await fetchSegments(track, video.videoId, key, null);
      return {
        languageCode: track.languageCode,
        segments,
        error: segments.length ? null : 'The caption track came back empty.',
      };
    } catch (error) {
      return { languageCode, segments: [], error: `Could not load captions: ${error?.message ?? error}` };
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
   * @returns {Promise<object>} A PROVIDE payload.
   */
  async function provide(languageCode) {
    const result = await sync();
    if (!result.ok) return { ok: false, error: result.error, video: describeVideo() };

    // Go through the player API when the page cannot be trusted: either its
    // track list belongs to the previous video (stale), or it has no player
    // data at all. In both cases we still know the video id from the URL, which
    // is all the player API needs.
    if (result.stale || !video.tracks.length) {
      const fetched = await fetchTrackViaInnertube(languageCode ?? 'en');
      video.segments = fetched.segments;
      if (fetched.segments.length) {
        return { ok: true, video: describeVideo(), requested: fetched.languageCode, fetched };
      }
      return { ok: false, error: fetched.error, video: describeVideo(), fetched };
    }

    const wanted = languageCode ? video.tracks.find((t) => t.languageCode === languageCode) : null;
    const track = wanted ?? pickDefaultTrack(video.tracks);
    const fetched = await fetchTrack(track.languageCode);
    video.segments = fetched.segments;

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
      video = { videoId: null, title: null, isLive: false, tracks: [], segments: null, needsInnertube: false };
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
      trackList: video.tracks.map((t) => ({
        languageCode: t.languageCode,
        name: t.name,
        kind: t.kind,
      })),
    };
  }

  // --- Service-worker requests ---------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== TARGET.CONTENT) return false;

    switch (message.type) {
      case MSG.DESCRIBE:
        sync()
          .then((result) => sendResponse({ ok: result.ok, error: result.error, video: describeVideo() }))
          .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
        return true; // async reply

      case MSG.PROVIDE:
        provide(message.languageCode ?? null)
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
        return true;

      case MSG.FETCH_TRACK:
        fetchTrack(message.languageCode)
          .then(sendResponse)
          .catch((error) =>
            sendResponse({ languageCode: message.languageCode, segments: [], error: String(error?.message ?? error) }),
          );
        return true;

      case MSG.CONTENT_SEEK: {
        const element = getVideo();
        if (element && Number.isFinite(message.seconds)) element.currentTime = message.seconds;
        sendResponse({ ok: Boolean(element) });
        return false;
      }

      default:
        return false;
    }
  });

  /** @param {object} payload */
  function post(payload) {
    chrome.runtime.sendMessage(payload).catch(() => {
      // No receiver (worker restarting) is a normal state.
    });
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

  setInterval(() => {
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
  }, VIDEO_CHECK_MS);

  setInterval(() => {
    if (!video.segments?.length) return;
    const seconds = getPosition();
    const index = findActiveIndex(video.segments, seconds);
    if (index === lastActiveIndex) return;
    lastActiveIndex = index;
    post({ type: MSG.CONTENT_POSITION, target: TARGET.BACKGROUND, index, seconds });
  }, POSITION_POLL_MS);

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
