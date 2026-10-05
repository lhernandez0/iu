/**
 * YouTube content script — runs in the ISOLATED world.
 *
 * Responsibilities:
 *   1. Ask the MAIN-world page bridge for the player response (see
 *      page-bridge.js for why that indirection is necessary).
 *   2. Fetch the caption track and parse it into segments.
 *   3. Answer side-panel requests: give me the transcript / seek / select a
 *      language / tell me where we are.
 *   4. Tell the panel when the video changes so it can drop a stale transcript.
 *
 * Injected as a CLASSIC script (content scripts cannot use `import`), so the
 * message names below duplicate src/common/messages.js and the segment helpers
 * duplicate src/common/transcript.js. Keep them in step.
 */

(() => {
  // --- Duplicated contract -------------------------------------------------
  const CHANNEL = 'transcribe-ext';
  const MSG = {
    GET_TRANSCRIPT: 'get-transcript',
    SEEK: 'seek',
    SELECT_TRACK: 'select-track',
    GET_POSITION: 'get-position',
    TRANSCRIPT_INVALIDATED: 'transcript-invalidated',
    POSITION: 'position',
  };
  const TARGET = { SIDEPANEL: 'sidepanel', CONTENT: 'content' };

  const POSITION_POLL_MS = 250;

  /** @type {{videoId: string|null, title: string|null, isLive: boolean, tracks: object[], languageCode: string|null, segments: object[]|null, error: string|null, innertubeApiKey: string|null}} */
  let state = {
    videoId: null,
    title: null,
    isLive: false,
    tracks: [],
    languageCode: null,
    segments: null,
    error: null,
    innertubeApiKey: null,
  };

  let loading = null;
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
      // Single-page app navigation: whatever we cached belongs to the old video.
      invalidate();
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
   * @param {string|null} translateTo
   * @returns {Promise<object[]>}
   */
  async function fetchSegments(track, translateTo) {
    const url = buildTrackUrl(track.baseUrl, translateTo);

    const direct = await fetch(url, { credentials: 'include' }).catch(() => null);
    if (direct?.ok) {
      const body = await direct.text();
      if (body.trim()) return parseTimedText(body);
    }

    // --- Fallback: INNERTUBE ------------------------------------------------
    // Re-ask the internal player API for the track list, which hands back a
    // freshly signed baseUrl that is valid for this session.
    const key = state.innertubeApiKey;
    if (!key || !state.videoId) return [];

    const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } },
        videoId: state.videoId,
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
   * Load the transcript for the current video, reusing whatever is cached.
   *
   * @param {string|null} languageCode
   * @returns {Promise<void>}
   */
  async function ensureTranscript(languageCode = null) {
    if (loading) return loading;

    loading = (async () => {
      const summary = await askBridge('get-player-response');
      if (!summary) {
        state = { ...state, segments: null, error: 'This page has no video player.' };
        return;
      }

      const sameVideo = summary.videoId === state.videoId;
      state = { ...state, ...summary, videoId: summary.videoId, title: summary.title };

      if (!summary.tracks.length) {
        state.segments = null;
        state.error = 'This video has no captions.';
        return;
      }

      const wanted =
        languageCode ??
        (sameVideo ? state.languageCode : null) ??
        pickDefaultTrack(summary.tracks)?.languageCode ??
        summary.tracks[0].languageCode;

      // Already loaded for this video and language — nothing to do.
      if (sameVideo && state.segments && state.languageCode === wanted) return;

      const track = summary.tracks.find((t) => t.languageCode === wanted) ?? summary.tracks[0];
      state.languageCode = track.languageCode;
      state.error = null;

      try {
        const segments = await fetchSegments(track, null);
        state.segments = segments;
        if (!segments.length) state.error = 'The caption track came back empty.';
      } catch (error) {
        state.segments = null;
        state.error = `Could not load captions: ${error?.message ?? error}`;
      }
    })();

    try {
      await loading;
    } finally {
      loading = null;
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

  /** Drop cached state; the next request reloads. */
  function invalidate() {
    state = { ...state, videoId: null, segments: null, languageCode: null, error: null };
    lastActiveIndex = -2;
    post({ type: MSG.TRANSCRIPT_INVALIDATED, target: TARGET.SIDEPANEL });
  }

  // --- Side-panel requests -------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== TARGET.CONTENT) return false;

    switch (message.type) {
      case MSG.GET_TRANSCRIPT:
        ensureTranscript(message.languageCode ?? null)
          .then(() => sendResponse(snapshot()))
          .catch((error) => sendResponse({ error: String(error?.message ?? error) }));
        return true; // async reply

      case MSG.SEEK: {
        const video = getVideo();
        if (video && Number.isFinite(message.seconds)) video.currentTime = message.seconds;
        sendResponse({ ok: Boolean(video) });
        return false;
      }

      case MSG.SELECT_TRACK:
        state.segments = null;
        ensureTranscript(message.languageCode ?? null)
          .then(() => sendResponse(snapshot()))
          .catch((error) => sendResponse({ error: String(error?.message ?? error) }));
        return true;

      case MSG.GET_POSITION:
        sendResponse({ seconds: getPosition(), paused: getVideo()?.paused ?? true });
        return false;

      default:
        return false;
    }
  });

  /** @returns {object} The panel's view of the world. */
  function snapshot() {
    return {
      videoId: state.videoId,
      title: state.title,
      isLive: state.isLive,
      error: state.error,
      languageCode: state.languageCode,
      tracks: state.tracks.map((t) => ({ languageCode: t.languageCode, name: t.name, kind: t.kind })),
      segments: state.segments ?? [],
    };
  }

  /** @param {object} payload */
  function post(payload) {
    chrome.runtime.sendMessage(payload).catch(() => {
      // No receiver (panel closed) is a normal state.
    });
  }

  // --- Position reporting --------------------------------------------------

  // Send an update only when the active segment changes, rather than streaming
  // the raw playback position four times a second.
  setInterval(() => {
    if (!state.segments?.length) return;
    const index = findActiveIndex(state.segments, getPosition());
    if (index === lastActiveIndex) return;
    lastActiveIndex = index;
    post({ type: MSG.POSITION, target: TARGET.SIDEPANEL, index, seconds: getPosition() });
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

  // Warm the cache as soon as we land on a video, so the panel is instant.
  ensureTranscript().catch(() => {});
})();
