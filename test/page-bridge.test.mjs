/**
 * Boots the MAIN-world page bridge with stubs and drives its message protocol.
 *
 * The bridge is the only thing that reads YouTube's page state, and every
 * failure it could have is silent: read the wrong property and the panel reports
 * "this video has no captions", which is a legitimate-looking answer to a bug.
 * That is worth pinning down.
 *
 * It is a classic IIFE with no exports, so it is evaluated for real and driven
 * through `window.postMessage`, exactly as the content script drives it.
 *
 * Run with `npm test`.
 */

let failures = 0;
let checks = 0;
let bootCount = 0;

/** @param {string} name @param {any} actual @param {any} expected */
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  pass  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`);
    failures++;
  }
}

/** @param {string} name */
function section(name) {
  console.log(`\n${name}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Install globals and evaluate a fresh copy of the bridge.
 *
 * @param {object} options
 * @param {object} [options.playerResponse]  What the cached page global holds.
 * @param {string} [options.rawPlayerResponse] Alternative shape, as a JSON string.
 * @param {object} [options.ytcfg]           Page config, for the INNERTUBE key.
 * @param {string} [options.urlVideoId]       The video id in the page URL.
 * @param {object} [options.liveResponse]     What the live player reports, which
 *   is the only source that tracks an in-tab navigation.
 * @param {string} [options.domTitle]         The page's heading.
 * @param {boolean} [options.withVideoElement] Whether the page has a <video>.
 * @returns {Promise<object>} Handles for driving the bridge.
 */
async function bootBridge({
  playerResponse = null,
  rawPlayerResponse = null,
  ytcfg = null,
  urlVideoId = 'dQw4w9WgXcQ',
  liveResponse = null,
  domTitle = null,
  withVideoElement = false,
} = {}) {
  /** Everything the bridge posted to the window. */
  const posted = [];
  const windowListeners = [];
  const documentListeners = new Map();

  // Stands in for the player element. `getPlayerResponse` is the live source, so
  // a test can make the page global stale while this stays current, which is
  // exactly the state after an in-tab navigation.
  const playerElement = withVideoElement
    ? { getPlayerResponse: () => liveResponse ?? playerResponse }
    : null;

  const domTitleElement = domTitle ? { textContent: domTitle } : null;

  const pageWindow = {
    location: { origin: 'https://www.youtube.com', href: `https://www.youtube.com/watch?v=${urlVideoId ?? videoId ?? ''}` },
    ytInitialPlayerResponse: playerResponse ?? undefined,
    ytplayer: rawPlayerResponse ? { config: { args: { raw_player_response: rawPlayerResponse } } } : undefined,
    ytcfg: ytcfg ?? undefined,
    addEventListener: (type, handler) => {
      if (type === 'message') windowListeners.push(handler);
    },
    postMessage: (data) => posted.push(data),
  };

  define('window', pageWindow);
  define('document', {
    addEventListener: (type, handler) => {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    // The bridge reads the live player and the page's heading. Both are absent
    // by default here, so a test only gets them by asking for them, which is
    // how the stale-response cases are exercised.
    getElementById: (id) => (id === 'movie_player' ? playerElement : null),
    querySelector: (selector) => (selector.includes('ytd-watch-metadata') ? domTitleElement : null),
  });

  await import(`../src/content/page-bridge.js?boot=${++bootCount}`);
  await settle();

  return {
    /**
     * Send a request the way the content script does.
     *
     * @param {string} type
     * @returns {object|null} The response payload, or null if nothing came back.
     */
    async ask(type) {
      const requestId = `test-${type}`;
      posted.length = 0;
      for (const handler of windowListeners) {
        handler({
          source: pageWindow,
          origin: pageWindow.location.origin,
          data: { channel: 'iu-ext', direction: 'request', requestId, type },
        });
      }
      await settle();
      return posted.find((message) => message.direction === 'response' && message.requestId === requestId) ?? null;
    },
    /** Fire a page navigation event. */
    navigate() {
      for (const handler of documentListeners.get('yt-navigate-finish') ?? []) handler();
    },
    posted,
    pageWindow,
    windowListenerCount: () => windowListeners.length,
  };
}

/** @param {string} name @param {any} value */
function define(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

// --- Fixtures ----------------------------------------------------------------
//
// Two players, for two jobs.
//
// The derived one (`SYNTHETIC`) is a real capture's player response, real language
// codes, real names, all 156 translation languages, real renderer keys. Use it when
// the question is "does the bridge read what YouTube actually sends", which is the
// question this suite exists to answer.
//
// The crafted one below is small and deliberately awkward: a `runs` name beside a
// `simpleText` one, an `asr` track, a region-tagged translation language. It exists
// to pin the VARIETY in the payload, which one capture may not happen to contain.
// Its values are arbitrary and it is not a claim about YouTube's shape.

import { fixture, summaryFrom } from './synthetic/load.mjs';

const SYNTHETIC = fixture();

const playerResponseFrom = (synthetic) =>
  synthetic.playerResponse ?? {
    videoDetails: { videoId: 'fallback', title: synthetic.video.title, isLiveContent: false },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: summaryFrom(synthetic).tracks.map((track) => ({
          baseUrl: track.baseUrl,
          languageCode: track.languageCode,
          name: { simpleText: track.name },
          kind: track.kind ?? undefined,
          isTranslatable: track.isTranslatable,
          vssId: track.vssId,
        })),
        translationLanguages: (synthetic.video.translationLanguages ?? []).map((language) => ({
          languageCode: language.languageCode,
          languageName: { runs: [{ text: language.name }] },
        })),
      },
    },
  };

const PLAYER_RESPONSE = {
  videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Test Video', isLiveContent: false },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en',
          languageCode: 'en',
          name: { simpleText: 'English' },
          isTranslatable: true,
          vssId: '.en',
        },
        {
          baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=de',
          // Some tracks carry the name as runs rather than simpleText. Reading
          // only simpleText would show `undefined` in the picker.
          name: { runs: [{ text: 'Deutsch' }] },
          languageCode: 'de',
          kind: 'asr',
          isTranslatable: false,
        },
      ],
      // The languages this video can be translated into. NOTE the label shape:
      // these use `runs[0].text` where the tracks above mostly use
      // `simpleText`, which is an inconsistency in YouTube's own payload.
      translationLanguages: [
        {
          languageCode: 'en',
          languageName: { runs: [{ text: 'English' }] },
        },
        {
          languageCode: 'ja',
          languageName: { runs: [{ text: 'Japanese' }] },
        },
        {
          languageCode: 'zh-Hant',
          languageName: { runs: [{ text: 'Chinese (Traditional)' }] },
          translationSourceTrackIndices: [4],
        },
      ],
    },
  },
};

// --- 1. It evaluates ---------------------------------------------------------

section('bridge evaluates');

{
  let error = null;
  try {
    await bootBridge({ playerResponse: PLAYER_RESPONSE });
  } catch (thrown) {
    error = thrown;
  }
  check('module evaluates', error, null);
}

// --- 2. The happy path -------------------------------------------------------

section('reports a REAL player response, not a hand-written idea of one');

{
  // Built from a real capture: real renderer keys (`audioTracks`,
  // `defaultAudioTrackIndex` included), real language codes, real names, and all
  // 156 translation languages. The crafted fixture above pins variety; this pins
  // fidelity, which is the thing that was missing.
  const bridge = await bootBridge({
    playerResponse: playerResponseFrom(SYNTHETIC),
    // The URL has to carry the same id as the payload. The bridge takes the video
    // id from the URL on purpose, that is the only signal that survives an in-tab
    // navigation, so a test that leaves the default id here is testing a mismatch
    // rather than the fixture.
    urlVideoId: SYNTHETIC.video.videoId,
    ytcfg: { get: (key) => (key === 'INNERTUBE_API_KEY' ? 'KEY123' : null) },
  });

  const payload = (await bridge.ask('get-player-response'))?.payload;

  check('the video is identified', payload?.videoId, SYNTHETIC.video.videoId);
  check('every real track is reported', payload?.tracks?.length, SYNTHETIC.tracks.length);
  check('with the real codes', payload?.tracks?.map((t) => t.languageCode), SYNTHETIC.tracks.map((t) => t.languageCode));
  check('and the real names', payload?.tracks?.map((t) => t.name), SYNTHETIC.tracks.map((t) => t.name));
  // Both tracks on the real video report `kind: null` even though their URLs carry
  // `caps=asr`. A fixture that "helpfully" called them asr would be inventing.
  check('the real kinds, null included', payload?.tracks?.map((t) => t.kind ?? null), SYNTHETIC.tracks.map((t) => t.kind ?? null));
  // The whole list, not a sample. This is what the picker is populated from.
  check(
    'the full translation-language list',
    payload?.translationLanguages?.length,
    SYNTHETIC.video.translationLanguages.length,
  );
  check('with region-tagged codes intact', payload.translationLanguages.some((l) => l.languageCode.includes('-')), true);
  // A payload missing this is a payload YouTube does not send. The bridge does not
  // read it, but its absence would mean the fixture had drifted from the capture.
  check(
    'the renderer still carries defaultAudioTrackIndex',
    SYNTHETIC.playerResponse.captions.playerCaptionsTracklistRenderer.defaultAudioTrackIndex !== undefined,
    true,
  );
}

section('reports the video and its caption tracks');

{
  const bridge = await bootBridge({
    playerResponse: PLAYER_RESPONSE,
    ytcfg: { get: (key) => (key === 'INNERTUBE_API_KEY' ? 'KEY123' : null) },
  });

  const reply = await bridge.ask('get-player-response');
  check('answered', reply?.ok, true);

  const payload = reply?.payload;
  check('video id', payload?.videoId, 'dQw4w9WgXcQ');
  check('title', payload?.title, 'Test Video');
  check('not live', payload?.isLive, false);
  check('both tracks', payload?.tracks?.length, 2);
  check('language code', payload?.tracks?.[0]?.languageCode, 'en');
  check('name from simpleText', payload?.tracks?.[0]?.name, 'English');
  check('name from runs[0].text', payload?.tracks?.[1]?.name, 'Deutsch');
  check('generated flag carried', payload?.tracks?.[1]?.kind, 'asr');
  check('translatable flag carried', payload?.tracks?.[0]?.isTranslatable, true);
  check('the baseUrl is passed through', payload?.tracks?.[0]?.baseUrl?.includes('timedtext'), true);
  check('the INNERTUBE key is exposed', payload?.innertubeApiKey, 'KEY123');

  // The translate menu is per video, so it has to travel with the description.
  // Without it the panel has no list to offer and no way to learn one, since it
  // must not hardcode YouTube's languages.
  check('the translation languages are reported', payload?.translationLanguages?.length, 3);
  check('with their codes', payload?.translationLanguages?.map((l) => l.languageCode), ['en', 'ja', 'zh-Hant']);
  // Read from runs, unlike the track names above. Getting this backwards yields
  // blank options in the picker rather than an error.
  check('and their names from runs[0].text', payload?.translationLanguages?.[1]?.name, 'Japanese');
  check('including ones with a region suffix', payload?.translationLanguages?.[2]?.name, 'Chinese (Traditional)');
}

section('a video that offers no translations reports an empty list');

{
  // Not every video can be translated. An absent list must be a list, not
  // undefined, or the panel has to defend against it everywhere it is used.
  const bridge = await bootBridge({
    playerResponse: {
      videoDetails: { videoId: 'notransl1', title: 'No Translations', isLiveContent: false },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en',
              languageCode: 'en',
              name: { simpleText: 'English' },
              isTranslatable: false,
            },
          ],
        },
      },
    },
    urlVideoId: 'notransl1',
  });

  const payload = (await bridge.ask('get-player-response'))?.payload;
  check('the track is still reported', payload?.tracks?.length, 1);
  check('the translation list is empty', payload?.translationLanguages?.length, 0);
  check('and it is an array, not undefined', Array.isArray(payload?.translationLanguages), true);
}

// --- 3. Degraded pages ------------------------------------------------------

section('a URL with no player data still identifies the video');

{
  // Better than reporting nothing: the id comes from the URL, which is enough
  // for the caller to resolve captions through the internal player API.
  const bridge = await bootBridge({ playerResponse: null, urlVideoId: 'knownvideo1' });
  const reply = await bridge.ask('get-player-response');
  check('the video is identified', reply?.payload?.videoId, 'knownvideo1');
  check('with no tracks', reply?.payload?.tracks?.length, 0);
  check('and nothing claimed as stale', reply?.payload?.stale, false);
}

section('a video with no captions reports an empty track list');

{
  const bridge = await bootBridge({
    playerResponse: { videoDetails: { videoId: 'x', title: 'No Captions', isLiveContent: false } },
    urlVideoId: 'x',
  });
  const reply = await bridge.ask('get-player-response');
  check('the video is still identified', reply?.payload?.videoId, 'x');
  check('no tracks', reply?.payload?.tracks?.length, 0);
}

// --- In-tab navigation -------------------------------------------------------
//
// The bug this pins: `ytInitialPlayerResponse` is only correct for the page as
// first loaded. YouTube does NOT replace it when you switch video inside a tab,
// so a bridge that trusts it keeps reporting the first video watched. That left
// the panel showing the old transcript while the highlight tracked the new
// video.

section('after an in-tab navigation the URL is the authority, not the page global');

{
  const bridge = await bootBridge({
    // The stale global still describes the FIRST video.
    playerResponse: PLAYER_RESPONSE,
    urlVideoId: 'newvideo123',
    domTitle: 'The New Video',
    withVideoElement: true,
    // The live player was not replaced either, in this scenario.
    liveResponse: null,
  });

  const reply = await bridge.ask('get-player-response');
  check('it reports the video from the URL', reply?.payload?.videoId, 'newvideo123');
  check('and flags the response as stale', reply?.payload?.stale, true);
  check('the title comes from the page, not the stale response', reply?.payload?.title, 'The New Video');
}

section('a stale track list is still reported, so the caller can avoid using it');

{
  const bridge = await bootBridge({
    playerResponse: PLAYER_RESPONSE,
    urlVideoId: 'newvideo123',
    withVideoElement: true,
  });

  const reply = await bridge.ask('get-player-response');
  // The tracks belong to the previous video. They are passed through rather than
  // silently dropped so the caller can see how many there were, but `stale` is
  // what tells it not to fetch them.
  check('the previous video tracks are visible', reply?.payload?.tracks?.length, 2);
  check('and marked stale', reply?.payload?.stale, true);
}

section('the live player wins when it has a fresh response');

{
  const fresh = {
    videoDetails: { videoId: 'freshvideo1', title: 'Fresh', isLiveContent: false },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: 'https://www.youtube.com/api/timedtext?v=fresh&lang=en', languageCode: 'en', name: { simpleText: 'English' } },
        ],
      },
    },
  };

  const bridge = await bootBridge({
    playerResponse: PLAYER_RESPONSE, // stale global
    liveResponse: fresh, // live player knows better
    urlVideoId: 'freshvideo1',
    withVideoElement: true,
  });

  const reply = await bridge.ask('get-player-response');
  check('the live response is used', reply?.payload?.videoId, 'freshvideo1');
  check('so nothing is stale', reply?.payload?.stale, false);
  check('and the fresh tracks are offered', reply?.payload?.tracks?.length, 1);
  check('with the fresh title', reply?.payload?.title, 'Fresh');
}

section('a page with no video id at all is not mistaken for a watch page');

{
  const bridge = await bootBridge({ playerResponse: PLAYER_RESPONSE, urlVideoId: '' });
  const reply = await bridge.ask('get-player-response');
  check('nothing is reported', reply?.payload, null);
}

section('falls back to ytplayer.config.args.raw_player_response when needed');

{
  // Some page types expose the response as a JSON string instead of an object.
  const bridge = await bootBridge({ rawPlayerResponse: JSON.stringify(PLAYER_RESPONSE) });
  const reply = await bridge.ask('get-player-response');
  check('found the alternative shape', reply?.payload?.videoId, 'dQw4w9WgXcQ');
  check('and its tracks', reply?.payload?.tracks?.length, 2);
}

section('a live video is flagged as such');

{
  const bridge = await bootBridge({
    playerResponse: { ...PLAYER_RESPONSE, videoDetails: { ...PLAYER_RESPONSE.videoDetails, isLiveContent: true } },
  });
  const reply = await bridge.ask('get-player-response');
  check('isLive', reply?.payload?.isLive, true);
}

// --- 4. Protocol -------------------------------------------------------------

section('an unknown request is refused rather than answered vacuously');

{
  const bridge = await bootBridge({ playerResponse: PLAYER_RESPONSE });
  const reply = await bridge.ask('something-else');
  check('not ok', reply?.ok, false);
  check('with a reason', typeof reply?.payload?.error, 'string');
}

section('navigation events are announced');

{
  const bridge = await bootBridge({ playerResponse: PLAYER_RESPONSE });
  bridge.posted.length = 0;
  bridge.navigate();
  await settle();
  check('a navigated event was posted', bridge.posted.some((m) => m.direction === 'event' && m.type === 'navigated'), true);
}

// --- 5. Re-entry guard -------------------------------------------------------

section('re-evaluating does not stack up duplicate listeners');

{
  // The worker injects this file on every request. Without the guard every
  // request would be answered once per injection.
  const bridge = await bootBridge({ playerResponse: PLAYER_RESPONSE });
  const before = bridge.windowListenerCount();
  await import(`../src/content/page-bridge.js?again=${Date.now()}`);
  await settle();
  check('no extra listener registered', bridge.windowListenerCount(), before);
}

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
