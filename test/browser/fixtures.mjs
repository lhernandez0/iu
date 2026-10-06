/**
 * Fixtures for the browser tests: a fake YouTube and its caption payloads.
 *
 * Pure functions, no browser and no network, so the shapes the tests depend on
 * are readable in one place and can themselves be reasoned about.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * @param {object[]} [options.translationLanguages] Real ones, from a capture.
 * @returns {string}
 */
export function watchPage({ videoId, title, tracks, serveAsrNames = false, translationLanguages = null }) {
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
          // A capture knows which tracks really are translatable — YouTube will
          // not machine-translate a human-authored one, and assuming otherwise
          // would make the picker offer a menu that changes nothing.
          isTranslatable: track.isTranslatable ?? true,
        })),
        // From the capture when there is one, so the list is YouTube's rather
        // than two entries invented here. The fallback is deliberately small:
        // it only needs to prove the list is data-driven, not to be realistic.
        translationLanguages: (translationLanguages ?? [
          { languageCode: 'en', name: 'English' },
          { languageCode: 'ja', name: 'Japanese' },
        ]).map((language) => ({
          languageCode: language.languageCode,
          languageName: { runs: [{ text: language.name ?? language.languageCode }] },
        })),
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

    /**
     * Move playback to a position, the way watching the video would.
     *
     * Exists because the alternative — assigning currentTime from the test —
     * reaches different wrappers in different worlds, and because a source-less
     * media element never ADVANCES on its own. Setting it from inside the page is
     * the only way a test can put the extension at a position further down a long
     * transcript, which is what makes the follow-and-scroll path reachable at all.
     */
    window.__setPosition = (seconds) => {
      const player = document.getElementById('player');
      if (player) player.currentTime = seconds;
      return player ? player.currentTime : null;
    };

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

// --- Real captures -----------------------------------------------------------
//
// The fixtures above are written by hand, which means they encode what we BELIEVE
// YouTube sends. A capture recorded by tools/capture.mjs is what it actually
// sent — so a test that runs against one can falsify a wrong belief rather than
// confirm it.
//
// Fixtures are local (gitignored), so every reader here tolerates their absence:
// the tier reports what is missing and skips rather than failing, because a
// machine that has not run the capture tool is a setup state, not a broken build.

const CAPTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * Every video id that has been captured on this machine.
 *
 * @returns {string[]}
 */
export function listCaptures() {
  if (!existsSync(CAPTURE_ROOT)) return [];
  return readdirSync(CAPTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(CAPTURE_ROOT, name, 'normalised', 'video.json')))
    .sort();
}

/**
 * A captured video, in the shape the harness serves.
 *
 * Segment text and timings come from the capture, so what the panel renders is
 * the real transcript rather than something invented — which is the entire point.
 *
 * @param {string} videoId
 * @returns {{videoId: string, title: string, translationLanguages: object[], tracks: object[], capturedAt: string}|null}
 */
export function captureFor(videoId) {
  const dir = join(CAPTURE_ROOT, videoId, 'normalised');
  const videoFile = join(dir, 'video.json');
  if (!existsSync(videoFile)) return null;

  const video = JSON.parse(readFileSync(videoFile, 'utf8'));

  const tracks = (video.trackList ?? []).map((track) => {
    const suffix = track.kind === 'asr' ? '-asr' : '';
    const file = join(dir, `captions-${track.languageCode}${suffix}.json`);
    const segments = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).segments ?? [] : [];
    return { ...track, segments };
  });

  return {
    videoId,
    title: video.title ?? videoId,
    translationLanguages: video.translationLanguages ?? [],
    tracks,
    capturedAt: video.capturedAt ?? null,
  };
}

/**
 * A raw captured body, exactly as YouTube sent it.
 *
 * For the cases where the interesting question is what the REAL bytes contain —
 * markup inside caption text, say — rather than what our parser made of them.
 *
 * @param {string} videoId
 * @param {string} kind Substring to match, e.g. 'timedtext' or 'watch'.
 * @returns {string|null}
 */
export function rawCapture(videoId, kind) {
  const raw = join(CAPTURE_ROOT, videoId, 'raw');
  if (!existsSync(raw)) return null;
  const match = readdirSync(raw)
    .filter((name) => name.includes(kind))
    .sort()
    .pop();
  return match ? readFileSync(join(raw, match), 'utf8') : null;
}
