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
 * @param {object} [options.playerResponse]  What the page exposes.
 * @param {string} [options.rawPlayerResponse] Alternative shape, as a JSON string.
 * @param {object} [options.ytcfg]           Page config, for the INNERTUBE key.
 * @returns {Promise<object>} Handles for driving the bridge.
 */
async function bootBridge({ playerResponse = null, rawPlayerResponse = null, ytcfg = null } = {}) {
  /** Everything the bridge posted to the window. */
  const posted = [];
  const windowListeners = [];
  const documentListeners = new Map();

  const pageWindow = {
    location: { origin: 'https://www.youtube.com' },
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
          data: { channel: 'transcribe-ext', direction: 'request', requestId, type },
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
}

// --- 3. Degraded pages ------------------------------------------------------

section('a page with no player data answers nothing, rather than guessing');

{
  const bridge = await bootBridge({ playerResponse: null });
  const reply = await bridge.ask('get-player-response');
  check('answered', reply?.ok, true);
  check('with a null payload', reply?.payload, null);
}

section('a video with no captions reports an empty track list');

{
  const bridge = await bootBridge({
    playerResponse: { videoDetails: { videoId: 'x', title: 'No Captions', isLiveContent: false } },
  });
  const reply = await bridge.ask('get-player-response');
  check('the video is still identified', reply?.payload?.videoId, 'x');
  check('no tracks', reply?.payload?.tracks?.length, 0);
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
