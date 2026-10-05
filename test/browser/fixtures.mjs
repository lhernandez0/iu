/**
 * Fixtures for the browser tests: a fake YouTube and its caption payloads.
 *
 * Pure functions, no browser and no network, so the shapes the tests depend on
 * are readable in one place and can themselves be reasoned about.
 */

/** @typedef {{start: number, duration: number, text: string}} Segment */

/** @typedef {{languageCode: string, name: string, kind?: string|null, segments: Segment[]}} FixtureTrack */

/**
 * The JSON3 body YouTube returns for `fmt=json3`.
 *
 * @param {Segment[]} segments
 * @returns {string}
 */
export function json3Body(segments) {
  return JSON.stringify({
    events: segments.map((segment) => ({
      tStartMs: Math.round(segment.start * 1000),
      dDurationMs: Math.round(segment.duration * 1000),
      segs: [{ utf8: segment.text }],
    })),
  });
}

/**
 * The XML body, which is what arrives when a track does not support JSON3.
 *
 * @param {Segment[]} segments
 * @returns {string}
 */
export function xmlBody(segments) {
  const cues = segments
    .map((segment) => `  <text start="${segment.start}" dur="${segment.duration}">${segment.text}</text>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8" ?>\n<transcript>\n${cues}\n</transcript>`;
}

/**
 * A watch page carrying exactly what the extension reaches for.
 *
 * Three things have to be present or the extension has nothing to work with:
 *   - `window.ytInitialPlayerResponse`, which the MAIN-world bridge reads;
 *   - `window.ytcfg.get('INNERTUBE_API_KEY')`, for the fallback path;
 *   - a `<video>`, whose `currentTime` the seek assertions observe.
 *
 * `currentTime` is backed by a plain value on purpose. A real `<video>` with no
 * source refuses to hold a seek, so an assertion against it would prove nothing.
 *
 * @param {object} options
 * @param {string} options.videoId
 * @param {string} options.title
 * @param {FixtureTrack[]} options.tracks
 * @param {boolean} [options.serveAsrNames] Whether to omit names, as some do.
 * @returns {string}
 */
export function watchPage({ videoId, title, tracks, serveAsrNames = false }) {
  const playerResponse = {
    videoDetails: { videoId, title, isLiveContent: false },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks.map((track) => ({
          // The query string has to carry `lang`, because the route handler
          // picks the fixture track by reading it back.
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${track.languageCode}&fmt=json3`,
          languageCode: track.languageCode,
          name: serveAsrNames ? { runs: [{ text: track.name }] } : { simpleText: track.name },
          kind: track.kind ?? undefined,
          isTranslatable: true,
        })),
        // The translate menu, per video. Only two entries: the picker only needs
        // to prove the list came from the fixture rather than from a constant.
        translationLanguages: [
          { languageCode: 'en', languageName: { runs: [{ text: 'English' }] } },
          { languageCode: 'ja', languageName: { runs: [{ text: 'Japanese' }] } },
        ],
      },
    },
  };

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <h1 class="ytd-watch-metadata"><yt-formatted-string>${title}</yt-formatted-string></h1>
  <div id="movie_player"></div>
  <video id="player"></video>
  <script>
    window.ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};
    window.ytcfg = { get: (key) => (key === 'INNERTUBE_API_KEY' ? 'FIXTURE_KEY' : null) };

    // Read the REAL currentTime rather than overriding it.
    //
    // Overriding the accessor here does not work, and the reason is worth
    // knowing: the content script runs in an isolated world, and Chrome gives
    // each world its own wrapper for the same DOM node. An expando or accessor
    // installed by the page is therefore not what the content script's
    // \`video.currentTime = n\` reaches — it reaches the native setter. A
    // sourceless media element still holds a playback position, so reading the
    // native property is both simpler and actually observes the seek.
    window.__position = () => document.getElementById('player').currentTime;

    // Record navigation events so a test can tell an SPA transition happened.
    window.__navigations = 0;
    document.addEventListener('yt-navigate-finish', () => { window.__navigations++; });

    /**
     * Simulate an in-tab navigation, which is the case that broke the extension.
     *
     * What matters is what is deliberately NOT done here: the cached
     * \`ytInitialPlayerResponse\` is left describing the FIRST video, because
     * that is what YouTube does. The live player and the page heading move on.
     *
     * Set \`updatePlayer\` to false to model the harder case where even the live
     * player has not caught up yet, leaving the URL as the only signal.
     */
    window.__navigateTo = (videoId, newTitle, { updatePlayer = false } = {}) => {
      history.pushState({}, '', '/watch?v=' + videoId);
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string').textContent = newTitle;
      if (updatePlayer) {
        window.__liveResponse = {
          videoDetails: { videoId, title: newTitle, isLiveContent: false },
          captions: window.ytInitialPlayerResponse.captions,
        };
      }
      const player = document.getElementById('player');
      if (player) player.currentTime = 0;
      document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
    };

    // Only present when a navigation has updated the live player.
    window.__liveResponse = null;

    document.getElementById('movie_player').getPlayerResponse = () => window.__liveResponse;
  </script>
</body></html>`;
}

/** A small English track. */
export const ENGLISH = {
  languageCode: 'en',
  name: 'English',
  segments: [
    { start: 0, duration: 2, text: 'Hey there' },
    { start: 2, duration: 2, text: 'how are you' },
    { start: 4, duration: 2, text: 'welcome back' },
  ],
};

/** The same speech in German, with a small drift on every cue. */
export const GERMAN = {
  languageCode: 'de',
  name: 'Deutsch',
  segments: [
    { start: 0.2, duration: 2, text: 'Hallo' },
    { start: 2.1, duration: 2, text: 'wie geht es dir' },
    { start: 4.2, duration: 2, text: 'willkommen zurueck' },
  ],
};

/** A second video, so caching across videos can be observed. */
export const OTHER_ENGLISH = {
  languageCode: 'en',
  name: 'English',
  segments: [
    { start: 0, duration: 3, text: 'Second video' },
    { start: 3, duration: 3, text: 'different content' },
  ],
};
