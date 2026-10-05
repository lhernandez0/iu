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
  const CHANNEL = 'transcribe-ext';

  /** @returns {object | null} The live player response object, if any. */
  function getPlayerResponse() {
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
   * @param {object | null} playerResponse
   * @returns {object | null}
   */
  function summarize(playerResponse) {
    if (!playerResponse?.videoDetails) return null;

    const renderer = playerResponse.captions?.playerCaptionsTracklistRenderer;
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

    return {
      videoId: playerResponse.videoDetails.videoId ?? null,
      title: playerResponse.videoDetails.title ?? null,
      isLive: Boolean(playerResponse.videoDetails.isLiveContent),
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
