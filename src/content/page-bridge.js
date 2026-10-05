/**
 * Page bridge — runs in the page's MAIN world on youtube.com.
 *
 * Why this exists: the caption tracks for the video you are watching live in
 * `window.ytInitialPlayerResponse`, which belongs to the page's JavaScript
 * context. An isolated-world content script shares the DOM but NOT the JS
 * globals, so it cannot read that object. This script runs in the same context
 * as the page, reads what we need, and posts a compact summary back over
 * `window.postMessage`, which both worlds can see.
 *
 * Declared in manifest.json as a content script with `"world": "MAIN"` and
 * `run_at: document_start`, so it is present before the page's own scripts set
 * the player response up. It is injected as a CLASSIC script — no imports, and
 * the message names below are duplicated in src/content/youtube-content.js.
 *
 * Protocol (all via window.postMessage, same-origin):
 *   in   { channel, direction: 'request', requestId, type }
 *   out  { channel, direction: 'response', requestId, ok, payload }
 *   out  { channel, direction: 'event', type: 'navigated' }
 *
 * Nothing here mutates the page or touches the DOM; it only reads.
 */

(() => {
  // --- Re-entry guard ------------------------------------------------------
  // The worker injects this file on demand with chrome.scripting, which re-runs
  // it even when a copy is already live. Without this guard each injection would
  // add another set of window listeners, and every request would be answered
  // twice.
  if (window.__iuBridgeLoaded) return;
  window.__iuBridgeLoaded = true;

  const CHANNEL = 'iu-ext';

  /**
   * The player response for whatever is playing NOW.
   *
   * `ytInitialPlayerResponse` is only correct for the page as it was first
   * loaded. On an in-tab navigation to another video YouTube does NOT replace
   * it, so reading it alone pins the extension to the first video watched in a
   * tab — the panel keeps the old transcript, and the highlight drifts because
   * it is matching old cue times against new playback.
   *
   * The player element exposes the live response, and that one does change.
   *
   * @returns {object | null}
   */
  function getPlayerResponse() {
    // Live player first: this is the only source that tracks in-tab navigation.
    try {
      const player = document.getElementById('movie_player');
      const live = player?.getPlayerResponse?.();
      if (live?.videoDetails?.videoId) return live;
    } catch {
      /* the element is not always present or callable; fall through */
    }

    try {
      if (window.ytInitialPlayerResponse?.videoDetails) return window.ytInitialPlayerResponse;
    } catch {
      /* page may have redefined the property; fall through */
    }

    try {
      // Some page types expose it as a JSON string instead of an object.
      const raw = window.ytplayer?.config?.args?.raw_player_response;
      if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      /* ignore */
    }

    return null;
  }

  /**
   * The video id from the URL.
   *
   * This, not the player response, is authoritative for what the user is
   * looking at: it is updated by navigation even when the cached response is
   * not, which makes it the reliable signal that the video changed.
   *
   * @returns {string | null}
   */
  function getUrlVideoId() {
    try {
      const url = new URL(window.location.href);
      return (
        url.searchParams.get('v') ??
        /^\/shorts\/([\w-]+)/.exec(url.pathname)?.[1] ??
        /^\/live\/([\w-]+)/.exec(url.pathname)?.[1] ??
        null
      );
    } catch {
      return null;
    }
  }

  /** The title, read from the page when the response cannot supply it. */
  function getDomTitle() {
    try {
      return (
        document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ??
        document.querySelector('h1.title yt-formatted-string')?.textContent?.trim() ??
        null
      );
    } catch {
      return null;
    }
  }

  /** @returns {string | null} Key for the internal player API (INNERTUBE). */
  function getInnertubeKey() {
    try {
      return (
        window.ytcfg?.get?.('INNERTUBE_API_KEY') ??
        window.ytcfg?.data_?.INNERTUBE_API_KEY ??
        null
      );
    } catch {
      return null;
    }
  }

  /**
   * Trim the player response down to what the panel needs. The full object is
   * tens of kilobytes and mostly irrelevant to us.
   *
   * The video id deliberately comes from the URL rather than from the response.
   * They disagree after an in-tab navigation — the response is stale — and the
   * URL is the one that matches what is on screen, so it is what every
   * identity decision downstream should be made on.
   *
   * @param {object | null} playerResponse
   * @returns {object | null}
   */
  function summarize(playerResponse) {
    const details = playerResponse?.videoDetails;
    const videoId = getUrlVideoId() ?? details?.videoId ?? null;

    // No video id at all means this is not a watch page; nothing useful to say.
    if (!videoId) return null;

    const renderer = playerResponse?.captions?.playerCaptionsTracklistRenderer;
    const tracks = (renderer?.captionTracks ?? []).map((track) => ({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      // `simpleText` on most videos; `runs[0].text` on a few.
      name: track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? track.languageCode,
      // 'asr' means machine-generated, i.e. auto-captions.
      kind: track.kind ?? null,
      vssId: track.vssId ?? null,
      isTranslatable: Boolean(track.isTranslatable),
    }));

    // True when the response describes a DIFFERENT video than the one in the
    // URL — an in-tab navigation whose response we could not get fresh. The
    // track list is then the previous video's, and fetching those URLs would
    // download the wrong captions, so the caller is told and can go through the
    // internal player API instead.
    const responseVideoId = details?.videoId ?? null;
    const stale = Boolean(responseVideoId && responseVideoId !== videoId);

    return {
      videoId,
      stale,
      // The page's own heading is authoritative for what is on screen, and it
      // updates on navigation even when the cached response does not.
      title: getDomTitle() ?? (stale ? null : details?.title) ?? null,
      isLive: Boolean(details?.isLiveContent),
      tracks,
      innertubeApiKey: getInnertubeKey(),
    };
  }

  /** @param {object} event */
  function post(event) {
    try {
      window.postMessage({ channel: CHANNEL, ...event }, window.location.origin);
    } catch {
      /* the page is going away; nothing useful to do */
    }
  }

  window.addEventListener('message', (event) => {
    // Only accept messages this window sent to itself; ignore other frames.
    if (event.source !== window || event.origin !== window.location.origin) return;

    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'request') return;

    let payload = null;
    let ok = true;
    try {
      if (data.type === 'get-player-response') {
        payload = summarize(getPlayerResponse());
      } else if (data.type === 'video-id') {
        // Deliberately cheap: the content script polls this to notice when the
        // tab has moved to another video, and summarizing the whole track list
        // several times a second would be wasteful.
        payload = { videoId: getUrlVideoId() };
      } else {
        ok = false;
        payload = { error: `Unknown page-bridge request: ${data.type}` };
      }
    } catch (error) {
      ok = false;
      payload = { error: String(error?.message ?? error) };
    }

    post({ direction: 'response', requestId: data.requestId, ok, payload });
  });

  // YouTube is a single-page app: navigating between videos keeps this script
  // alive, so tell the content script when the URL's video may have changed.
  for (const eventName of ['yt-navigate-finish', 'yt-page-data-updated']) {
    document.addEventListener(eventName, () => post({ direction: 'event', type: 'navigated' }));
  }
})();
