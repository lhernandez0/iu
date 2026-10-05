/**
 * Boots the service worker against a chrome stub and drives it the way the
 * browser would. Run with `npm test`.
 *
 * The value here is not coverage — it is that the worker is *evaluated*. Static
 * checks prove imports and names line up; only running the module proves it does
 * not throw on the way up, which is the failure that makes the panel sit on its
 * placeholder with nothing to go on.
 *
 * Every section boots a fresh worker against its own stub. `chrome` is a single
 * global that each install replaces, so sharing one stub across sections means a
 * later install silently redirects an earlier section's calls.
 */

import { installChromeStub, createPanelPort } from './chrome-stub.mjs';

let failures = 0;
let checks = 0;
let bootCount = 0;

/**
 * @param {string} name
 * @param {any} actual
 * @param {any} expected
 */
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

/** Let queued microtasks and timers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Install a stub and evaluate the worker against it, with the panel connected.
 *
 * A unique query string defeats the module cache, so each call gets a fresh
 * evaluation of the worker — which is what makes the sections independent.
 *
 * @param {object} [options] Passed through to installChromeStub.
 * @returns {Promise<{listeners: object, calls: object, storage: object, received: object[], sendFromPanel: Function}>}
 */
async function boot(options = {}) {
  const { listeners, calls, storage } = installChromeStub(options);
  await import(`../src/background/service-worker.js?boot=${++bootCount}`);

  const panel = createPanelPort();
  for (const listener of listeners.connect) listener(panel.port);
  await settle();

  return { listeners, calls, storage, received: panel.received, sendFromPanel: panel.sendFromPanel };
}

// --- Fixtures ----------------------------------------------------------------

const ENGLISH = {
  languageCode: 'en',
  segments: [
    { start: 0, duration: 2, text: 'Hey there' },
    { start: 2, duration: 2, text: 'how are you' },
    { start: 4, duration: 2, text: 'welcome back' },
  ],
};

/** Slight drift on every cue, which is what a real track pair looks like. */
const GERMAN = {
  languageCode: 'de',
  segments: [
    { start: 0.2, duration: 2, text: 'Hallo' },
    { start: 2.1, duration: 2, text: 'wie geht es dir' },
    { start: 4.2, duration: 2, text: 'willkommen zurueck' },
  ],
};

const VIDEO = {
  videoId: 'dQw4w9WgXcQ',
  title: 'Test Video',
  isLive: false,
  trackList: [
    { languageCode: 'en', name: 'English', kind: null },
    { languageCode: 'de', name: 'Deutsch', kind: null },
  ],
};

const PROVIDE_OK = { ok: true, video: VIDEO, requested: 'en', fetched: ENGLISH };
const TRACK = (payload) => ({ providePayload: PROVIDE_OK, trackPayload: payload });

// --- 1. The worker evaluates ------------------------------------------------

section('worker loads without throwing at module scope');

let loadError = null;
try {
  await boot(TRACK(GERMAN));
} catch (error) {
  loadError = error;
}
check('module evaluates', loadError, null);

if (loadError) {
  console.log('\nA module-scope throw is fatal: the worker never answers the panel,');
  console.log('so the panel shows only whatever placeholder it set at startup.');
  process.exit(1);
}

// --- 2. First contact -------------------------------------------------------

section('panel connects and receives state');

{
  const { received, calls } = await boot(TRACK(GERMAN));
  const state = received.at(-1)?.state;

  check('panel was sent a STATE', received.at(-1)?.type, 'state');
  check('carries the video id', state?.videoId, 'dQw4w9WgXcQ');
  check('carries the title', state?.title, 'Test Video');
  check('carries the track list', state?.trackList?.length, 2);
  check('primary defaulted to the fetched track', state?.primary, 'en');
  check('secondary is opt-in, so null', state?.secondary, null);
  check('no error reported', state?.error, null);
  check('rows were built', state?.rows?.length, 3);
  check('a row has text', state?.rows?.[0]?.text, 'Hey there');
  check('a row carries duration for SRT export', state?.rows?.[0]?.duration, 2);
  check('no second track means empty secondary', state?.rows?.[0]?.secondary, '');

  section('both content scripts were injected, bridge first');
  check('injected twice', calls.executeScript.length, 2);
  check('first is the MAIN-world bridge', calls.executeScript[0]?.world, 'MAIN');
  check('bridge file', calls.executeScript[0]?.files?.[0], 'src/content/page-bridge.js');
  check('second is the isolated script', calls.executeScript[1]?.world, undefined);
  check('isolated file', calls.executeScript[1]?.files?.[0], 'src/content/youtube-content.js');
  check('targeted frame 0', calls.executeScript[0]?.target?.frameIds, [0]);
  check('targeted the tracked tab', calls.executeScript[0]?.target?.tabId, 1);
}

// --- 3. Dual subtitles ------------------------------------------------------

section('a second language produces aligned rows');

{
  const { received, storage, sendFromPanel } = await boot(TRACK(GERMAN));

  sendFromPanel({ type: 'set-secondary', languageCode: 'de' });
  await settle();

  const state = received.at(-1)?.state;
  check('secondary recorded', state?.secondary, 'de');
  check('still one row per primary cue', state?.rows?.length, 3);
  check('first pair', state?.rows?.[0]?.secondary, 'Hallo');
  check('second pair', state?.rows?.[1]?.secondary, 'wie geht es dir');
  check('third pair', state?.rows?.[2]?.secondary, 'willkommen zurueck');
  check('choice was persisted', storage.secondaryLanguage, 'de');
}

// --- 4. Mismatched tracks ---------------------------------------------------

section('a badly out-of-sync second track is left unpaired, never mismatched');

{
  const distant = { languageCode: 'fr', segments: [{ start: 30, duration: 2, text: 'tres loin' }] };
  const { received, sendFromPanel } = await boot(TRACK(distant));

  sendFromPanel({ type: 'set-secondary', languageCode: 'fr' });
  await settle();

  const rows = received.at(-1)?.state?.rows ?? [];
  check('rows still exist', rows.length, 3);
  check('no row adopted the distant cue', rows.every((r) => r.secondary === ''), true);
}

// --- 5. Caching -------------------------------------------------------------

section('a cached track is not fetched twice');

{
  const { calls, sendFromPanel } = await boot(TRACK(GERMAN));
  const count = () => calls.sendMessage.filter((c) => c?.message?.type === 'fetch-track').length;

  sendFromPanel({ type: 'set-secondary', languageCode: 'de' });
  await settle();
  const afterFirst = count();

  sendFromPanel({ type: 'set-secondary', languageCode: 'de' });
  await settle();

  check('the first selection fetched', afterFirst, 1);
  check('the second did not refetch', count(), afterFirst);
}

// --- 6. Seek ----------------------------------------------------------------

section('seek is forwarded to the page');

{
  const { calls, sendFromPanel } = await boot(TRACK(GERMAN));

  sendFromPanel({ type: 'seek', seconds: 42.5 });
  await settle();

  const seek = calls.sendMessage.find((c) => c?.message?.type === 'content-seek');
  check('content-seek was sent', Boolean(seek), true);
  check('with the right offset', seek?.message?.seconds, 42.5);
}

// --- 7. Playback reports ----------------------------------------------------

section('content-script reports reach the panel');

{
  const { listeners, received } = await boot(TRACK(GERMAN));

  listeners.message[0]({ target: 'background', type: 'content-position', index: 1, seconds: 2.5 });
  await settle();

  check('panel received a position', received.at(-1)?.type, 'position');
  check('with the index', received.at(-1)?.index, 1);
  check('with the offset', received.at(-1)?.seconds, 2.5);
}

// --- 8. Degraded cases ------------------------------------------------------

section('a video with no captions still reports its title');

{
  const { received } = await boot({
    providePayload: { ok: false, error: 'This video has no captions.', video: { ...VIDEO, trackList: [] } },
  });

  const state = received.at(-1)?.state;
  check('error surfaced', state?.error, 'This video has no captions.');
  check('title still shown', state?.title, 'Test Video');
  check('no rows', state?.rows?.length, 0);
}

section('a non-YouTube tab is reported rather than crashed on');

{
  const { received } = await boot({ tabs: [{ id: 1, active: true, url: 'https://example.com/' }] });
  check('an error is shown', typeof received.at(-1)?.state?.error, 'string');
  check('no rows', received.at(-1)?.state?.rows?.length, 0);
}

// --- Result -----------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
