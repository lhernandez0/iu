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
 * Wait until the panel's latest message satisfies a predicate.
 *
 * Marking, refetching and lookup all happen across asynchronous hops, so none of
 * them can be awaited directly. This used to be handled by sleeping: first 50ms,
 * then 100, then 200, each bump fixing one flaky test and together totalling
 * 3.5s of a 3.9s suite. A sleep is a guess in both directions — too short and the
 * test is intermittently wrong, too long and every run pays for the worst case.
 *
 * Returns as soon as the predicate holds, so a condition that is already true
 * costs nothing.
 *
 * @param {object[]} received  The panel's message log.
 * @param {(message: object) => boolean} predicate
 * @param {string} description  Named in the failure, so a timeout says what it waited for.
 * @param {number} [timeoutMs]
 * @returns {Promise<object>} The message that satisfied it.
 */
function waitForMessage(received, predicate, description, timeoutMs = 4000) {
  const current = received.at(-1);
  if (current && predicate(current)) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const message = received.at(-1);
      if (message && predicate(message)) {
        clearInterval(poll);
        resolve(message);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for: ${description}`));
      }
    }, 4);
  });
}

/**
 * The same, for a STATE push specifically.
 *
 * @param {object[]} received
 * @param {(state: object) => boolean} predicate
 * @param {string} description
 * @returns {Promise<object>} The state that satisfied it.
 */
async function waitForState(received, predicate, description) {
  const message = await waitForMessage(
    received,
    (m) => Boolean(m.state) && predicate(m.state),
    description,
  );
  return message.state;
}

/**
 * Wait until the transcript has been segmented and marked.
 *
 * "Every row has tokens" is exactly the condition `applyMarks` uses to decide
 * there is nothing left to do, so this watches the real completion signal.
 *
 * Only safe for a FIRST marking. `rebuildRows` carries tokens over by text, so
 * after a settings change every row already has tokens from the previous
 * marking — this would return immediately and hand back stale levels. Waiting
 * for a re-mark has to assert what actually changed.
 *
 * @param {object[]} received
 * @returns {Promise<object>}
 */
function waitForMarks(received) {
  const marked = (state) => {
    const rows = state?.rows ?? [];
    return rows.length > 0 && rows.every((row) => Array.isArray(row.tokens));
  };
  return waitForState(received, marked, 'the transcript to be marked');
}

/** Wait for the worker's first state push, so its initial refresh has finished. */
function waitForFirstState(received) {
  return waitForState(received, () => true, 'the first state push');
}

/**
 * Install a stub and evaluate the worker against it, with the panel connected.
 *
 * A unique query string defeats the module cache, so each call gets a fresh
 * evaluation of the worker — which is what makes the sections independent.
 *
 * @param {object} [options] Passed through to installChromeStub.
 * @returns {Promise<{listeners: object, calls: object, storage: object, received: object[], sendFromPanel: Function, disconnect: Function}>}
 */
async function boot(options = {}) {
  const stub = installChromeStub(options);
  await import(`../src/background/service-worker.js?boot=${++bootCount}`);

  const panel = connectPanel(stub);
  await settle();

  return {
    ...stub,
    received: panel.received,
    sendFromPanel: panel.sendFromPanel,
    disconnect: panel.disconnect,
    /** Open another panel against the SAME worker, as reopening one does. */
    reopen: () => connectPanel(stub),
  };
}

/**
 * Attach a panel port to an already-evaluated worker.
 *
 * Booting again would evaluate a fresh worker with fresh state, which is not
 * what reopening a panel does — the worker persists and only the port
 * reconnects. Testing the wrong one of those would prove nothing.
 *
 * @param {object} stub
 * @returns {object}
 */
function connectPanel(stub) {
  const panel = createPanelPort();
  for (const listener of stub.listeners.connect) listener(panel.port);
  return panel;
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
    { languageCode: 'en', name: 'English', kind: null, isTranslatable: true },
    { languageCode: 'de', name: 'Deutsch', kind: null, isTranslatable: true },
  ],
  // The translate menu, per video. Note `en` is offered even though it is also a
  // track: YouTube lists the source among its own targets.
  translationLanguages: [
    { languageCode: 'en', name: 'English' },
    { languageCode: 'ja', name: 'Japanese' },
    { languageCode: 'ko', name: 'Korean' },
  ],
};

const PROVIDE_OK = { ok: true, video: VIDEO, requested: 'en', fetched: ENGLISH };

/**
 * The stub's answer to DESCRIBE, which the worker now calls first so it can
 * consult its cache before paying for a download.
 *
 * @param {object} [video]
 * @param {string} [error]
 */
const DESCRIBE = (video = VIDEO, error) => ({ ok: !error, error, video });

/**
 * @param {any} trackPayload
 * @param {object} [options]
 */
const TRACK = (trackPayload, { video = VIDEO, provide = PROVIDE_OK, error } = {}) => ({
  describePayload: DESCRIBE(video, error),
  providePayload: provide,
  trackPayload,
});

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
  check('choice was persisted', storage.settings?.secondaryLanguage, 'de');
}

// --- 3b. Sticky language choices --------------------------------------------

/**
 * A content script that behaves like the real one: it loads the track it was
 * asked for, falls back to the first available only when that track is absent,
 * and honours a translation by changing the TEXT while keeping the source
 * language.
 *
 * Returning a fixed payload regardless of the request cannot test stickiness or
 * translation, because both ARE the request being honoured.
 *
 * @param {object} video
 * @param {Record<string, any>} tracksByLanguage
 */
const PROVIDER = (video, tracksByLanguage) => (request) => {
  const wanted = request?.languageCode;
  const languageCode = wanted && tracksByLanguage[wanted] ? wanted : video.trackList[0]?.languageCode;
  const segments = tracksByLanguage[languageCode];
  if (!segments) return { ok: false, error: 'This video has no captions.' };

  const translateTo = request?.translateTo ?? null;
  if (translateTo) {
    const track = video.trackList.find((t) => t.languageCode === languageCode);
    // A track that cannot be translated is refused rather than served
    // untranslated, which is what the real content script does.
    if (track && track.isTranslatable === false) {
      return { ok: false, error: 'This caption track cannot be auto-translated.', fetched: { languageCode, translateTo: null, segments: [], error: 'This caption track cannot be auto-translated.' } };
    }
    // Marked so a test can tell translated text from the original at a glance.
    return {
      ok: true,
      video,
      requested: languageCode,
      fetched: {
        languageCode,
        translateTo,
        segments: segments.map((s) => ({ ...s, text: `[${translateTo}] ${s.text}` })),
      },
    };
  }

  return { ok: true, video, requested: languageCode, fetched: { languageCode, translateTo: null, segments } };
};

const SEGMENTS = { en: ENGLISH.segments, de: GERMAN.segments };

/**
 * A FETCH_TRACK payload, which is the segment list itself rather than the
 * `{ok, video, fetched}` envelope PROVIDE returns. The two are different shapes
 * and using one where the other belongs fails as a silently empty transcript.
 *
 * @param {object} video
 * @param {Record<string, any>} tracksByLanguage
 */
const TRACK_FETCHER = (video, tracksByLanguage) => (request) => {
  const languageCode = request?.languageCode;
  const segments = tracksByLanguage[languageCode];
  if (!segments) return { languageCode, translateTo: null, segments: [], error: `No captions for ${languageCode}.` };

  const translateTo = request?.translateTo ?? null;
  if (translateTo) {
    const track = video.trackList.find((t) => t.languageCode === languageCode);
    if (track && track.isTranslatable === false) {
      return {
        languageCode,
        translateTo: null,
        segments: [],
        error: 'This caption track cannot be auto-translated.',
      };
    }
    return {
      languageCode,
      translateTo,
      segments: segments.map((s) => ({ ...s, text: `[${translateTo}] ${s.text}` })),
    };
  }
  return { languageCode, translateTo: null, segments };
};

section('a language choice survives moving to another video');

{
  // The learner's expectation, in their words: if my first choice is still
  // available then I expect it to stay my first choice, and the same for the
  // second. Primary was seeded as `null` on every new video, so a chosen primary
  // was silently replaced by the default on the next video.
  const secondVideo = { ...VIDEO, videoId: 'zzzzzzzzzzz', title: 'Second Video' };
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: GERMAN,
  });

  stub.sendFromPanel({ type: 'set-primary', languageCode: 'de' });
  await settle();
  check('primary chosen', stub.received.at(-1)?.state?.primary, 'de');
  check('and the German lines are on screen', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hallo');

  // Same tab, different video, same two tracks available.
  stub.setAnswer('describePayload', DESCRIBE(secondVideo));
  stub.setAnswer('providePayload', PROVIDER(secondVideo, SEGMENTS));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  check('the new video is on screen', stub.received.at(-1)?.state?.videoId, 'zzzzzzzzzzz');
  check('and it kept the chosen language', stub.received.at(-1)?.state?.primary, 'de');
  check('so the German lines are still shown', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hallo');
}

section('a language choice is kept for the video that has it, and restored later');

{
  // A video that lacks the chosen track must fall back rather than fail — but
  // the preference itself has to survive, or returning to a video that has the
  // language would come up in the wrong one.
  const portugueseOnly = {
    ...VIDEO,
    videoId: 'zzzzzzzzzzz',
    title: 'Portuguese Video',
    trackList: [{ languageCode: 'pt', name: 'Portugues', kind: null }],
  };
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: GERMAN,
  });

  stub.sendFromPanel({ type: 'set-primary', languageCode: 'de' });
  await settle();

  stub.setAnswer('describePayload', DESCRIBE(portugueseOnly));
  stub.setAnswer('providePayload', PROVIDER(portugueseOnly, { pt: [{ start: 0, duration: 2, text: 'Ola' }] }));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  check('the video without the language falls back', stub.received.at(-1)?.state?.primary, 'pt');
  check('and shows what it does have', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Ola');
  check('but the preference is remembered', stub.storage.settings?.primaryLanguage, 'de');

  // Back to a video that has German: the choice comes back on its own.
  stub.setAnswer('describePayload', DESCRIBE(VIDEO));
  stub.setAnswer('providePayload', PROVIDER(VIDEO, SEGMENTS));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  check('returning to a video with the language restores it', stub.received.at(-1)?.state?.primary, 'de');
  check('and its lines are shown again', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hallo');
}

section('both languages stay chosen together');

{
  // The pair has to move as a pair. Selecting a secondary and then switching
  // video used to keep only one of them.
  const secondVideo = { ...VIDEO, videoId: 'zzzzzzzzzzz', title: 'Second Video' };
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: GERMAN,
  });

  stub.sendFromPanel({ type: 'set-secondary', languageCode: 'de' });
  await settle();

  stub.setAnswer('describePayload', DESCRIBE(secondVideo));
  stub.setAnswer('providePayload', PROVIDER(secondVideo, SEGMENTS));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  const state = stub.received.at(-1)?.state;
  check('primary stayed', state?.primary, 'en');
  check('secondary stayed', state?.secondary, 'de');
  check('and paired rows are still produced', state?.rows?.[0]?.secondary, 'Hallo');
}

// --- 3d. Auto-translate ------------------------------------------------------

section('choosing a translation re-fetches the track and shows translated text');

{
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  check('the untranslated text is on screen first', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hey there');

  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: 'ja' });
  await settle();

  const state = stub.received.at(-1)?.state;
  check('the translated text is shown', state?.rows?.[0]?.text, '[ja] Hey there');
  // The cache is keyed on the SOURCE track, so this must not have become a `ja`
  // track — that would collide with a real Japanese track on the same video.
  check('the primary language is still the source', state?.primary, 'en');
  check('and the target is reported apart from it', state?.translatePrimary, 'ja');
  check('no error', state?.error, null);
}

section('the translate menu comes from the video, and excludes the source language');

{
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  const state = stub.received.at(-1)?.state;
  check('the languages are offered', state?.translationLanguages?.length, 3);
  check('with their codes', state?.translationLanguages?.map((l) => l.languageCode), ['en', 'ja', 'ko']);
  // Translating a track into itself does nothing, so it must not be offered as
  // an option that appears to have no effect.
  check('the panel can filter the source out', state?.translationLanguages?.some((l) => l.languageCode === state.primary), true);
}

section('going back to the original refetches rather than keeping the translation');

{
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: 'ja' });
  await settle();
  check('translated', stub.received.at(-1)?.state?.rows?.[0]?.text, '[ja] Hey there');

  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: null });
  await settle();

  const state = stub.received.at(-1)?.state;
  check('back to the original text', state?.rows?.[0]?.text, 'Hey there');
  check('and the target is cleared', state?.translatePrimary, null);
}

section('a translation survives moving to another video');

{
  // Same stickiness as the language choices: the preference is global, and the
  // rendering is per video.
  const secondVideo = { ...VIDEO, videoId: 'zzzzzzzzzzz', title: 'Second Video' };
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: 'ja' });
  await settle();

  stub.setAnswer('describePayload', DESCRIBE(secondVideo));
  stub.setAnswer('providePayload', PROVIDER(secondVideo, SEGMENTS));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  const state = stub.received.at(-1)?.state;
  check('the new video is on screen', state?.videoId, 'zzzzzzzzzzz');
  check('and it is translated too', state?.rows?.[0]?.text, '[ja] Hey there');
}

section('a video whose track cannot be translated falls back to the original');

{
  // The important one. A translation is a nice-to-have; the transcript is not.
  // Asking for a translation a video cannot produce must not blank the screen or
  // wipe the transcript from the cache.
  const untranslatable = {
    ...VIDEO,
    trackList: [{ languageCode: 'en', name: 'English', kind: 'asr', isTranslatable: false }],
  };
  const stub = await boot({
    describePayload: DESCRIBE(untranslatable),
    providePayload: PROVIDER(untranslatable, SEGMENTS),
    trackPayload: TRACK_FETCHER(untranslatable, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: 'ja' });
  await settle();

  const state = stub.received.at(-1)?.state;
  check('the original text is still on screen', state?.rows?.[0]?.text, 'Hey there');
  check('with no translation applied', state?.translatePrimary, null);
  check('and the reason is reported', String(state?.error ?? '').includes('translat'), true);

  // And it recovers: clearing the translation clears the message.
  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: null });
  await settle();
  check('clearing it clears the error', stub.received.at(-1)?.state?.error, null);
  check('and the transcript is intact', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hey there');
}

section('a cached track still refetches when the translation changed');
{
  // A translation is a different RENDERING of the same track, so "the track is
  // in the cache" and "the right text is on screen" are different questions. The
  // cache check has to compare the rendering too, or switching the target keeps
  // the old language because the source track is present either way.
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: 'ja' });
  await settle();
  check('translated to Japanese', stub.received.at(-1)?.state?.rows?.[0]?.text, '[ja] Hey there');

  // Switch target. The track is cached; the rendering is not.
  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: 'ko' });
  await settle();
  check('the new target is rendered', stub.received.at(-1)?.state?.rows?.[0]?.text, '[ko] Hey there');
  check('and reported', stub.received.at(-1)?.state?.translatePrimary, 'ko');

  // And the reverse: re-selecting the SAME target must not refetch.
  const before = stub.calls.sendMessage.filter((c) => c?.message?.type === 'fetch-track').length;
  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: 'ko' });
  await settle();
  const after = stub.calls.sendMessage.filter((c) => c.message?.type === 'fetch-track').length;
  check('re-selecting the same target does not refetch', after, before);
}

section('an untranslatable video is not asked again on every refresh');
{
  // The preference stays set, so without the translatability check every refresh
  // would re-request a translation that cannot exist — a wasted round trip and a
  // permanent error on screen.
  const untranslatable = {
    ...VIDEO,
    trackList: [{ languageCode: 'en', name: 'English', kind: 'asr', isTranslatable: false }],
  };
  const stub = await boot({
    describePayload: DESCRIBE(untranslatable),
    providePayload: PROVIDER(untranslatable, SEGMENTS),
    trackPayload: TRACK_FETCHER(untranslatable, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-setting', id: 'translatePrimary', value: 'ja' });
  await settle();

  const before = stub.calls.sendMessage.filter((c) => c?.message?.type === 'provide').length;
  stub.sendFromPanel({ type: 'refresh' });
  await settle();
  const after = stub.calls.sendMessage.filter((c) => c.message?.type === 'provide').length;

  check('the second refresh fetched nothing', after, before);
  check('the transcript is still shown', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hey there');
}

section('a translation needs its own track, and skips one that is already loaded');

{
  // A second subtitle is a track like any other. Translating a track that is not
  // loaded must fetch it rather than silently showing nothing.
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-secondary', languageCode: 'de' });
  await settle();
  check('second track loaded', stub.received.at(-1)?.state?.secondary, 'de');
  check('untranslated to start', stub.received.at(-1)?.state?.rows?.[0]?.secondary, 'Hallo');

  stub.sendFromPanel({ type: 'set-setting', id: 'translateSecondary', value: 'ja' });
  await settle();

  const state = stub.received.at(-1)?.state;
  check('the second line is translated', state?.rows?.[0]?.secondary, '[ja] Hallo');
  check('the first line is untouched', state?.rows?.[0]?.text, 'Hey there');
  check('and the second language is still the source', state?.secondary, 'de');
}

// --- 3c. Settings -----------------------------------------------------------

section('a stored setting is restored, and one out of range is corrected');

{
  // A value that made sense when it was stored may not make sense now — a size
  // of 40px would blow the panel apart, and an unknown word list has no levels.
  // The schema's coerce is what turns that into something renderable.
  //
  // The provider has to honour the requested language here, or "the restored
  // language was applied" would pass without the restore having done anything.
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: GERMAN,
    storage: {
      settings: { view: 'focus', textScale: 40, listId: 'nonsense', threshold: 2, primaryLanguage: 'de' },
    },
    // Storage is slow enough that a panel connecting immediately, as it does in
    // reality, would otherwise be served before the restore finished.
    storageDelay: 5,
  });
  // The restore is deliberately slow here (storageDelay), and the first refresh
  // waits on it — so this waits for the restored value rather than for a
  // duration. Reading too early sees no state at all, not default settings.
  const learning = (
    await waitForState(stub.received, (s) => s.learning?.view === 'focus', 'the settings to be restored')
  ).learning;
  check('a valid setting is restored', learning?.view, 'focus');
  check('an absurd text size is clamped', learning?.textScale, 3);
  check('an unknown word list falls back', learning?.listId !== 'nonsense', true);
  check('and the restored language was applied', stub.received.at(-1)?.state?.primary, 'de');
  check('and its lines were fetched, not the default ones', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hallo');
}

section('changing a setting is remembered');

{
  const stub = await boot(TRACK(GERMAN));

  stub.sendFromPanel({ type: 'set-setting', id: 'textScale', value: 1.45 });
  await settle();

  check('it landed in storage', stub.storage.settings?.textScale, 1.45);
  check('and is reflected in the state', stub.received.at(-1)?.state?.learning?.textScale, 1.45);

  stub.sendFromPanel({ type: 'set-setting', id: 'view', value: 'focus' });
  await settle();
  check('a second setting is stored alongside', stub.storage.settings?.view, 'focus');
  check('without losing the first', stub.storage.settings?.textScale, 1.45);

  // An unknown id should be ignored rather than written, so a panel from a newer
  // version cannot poison the stored object with keys nothing understands.
  stub.sendFromPanel({ type: 'set-setting', id: 'notASetting', value: 'x' });
  await settle();
  check('an unknown setting is ignored', 'notASetting' in (stub.storage.settings ?? {}), false);
  check('and a nonsense value is coerced, not stored raw', (() => {
    stub.sendFromPanel({ type: 'set-setting', id: 'textScale', value: 'huge' });
    return true;
  })(), true);
  await settle();
  check('the nonsense size fell back to the default', stub.storage.settings?.textScale, 1);
}

section('the choices a learner makes are all reported back in the learning block');

{
  const stub = await boot(TRACK(GERMAN));
  const learning = stub.received.at(-1)?.state?.learning;

  // The panel renders its controls from this block, so a missing key is a
  // control that silently never updates.
  for (const key of ['view', 'textScale', 'listId', 'threshold', 'primaryLanguage', 'secondaryLanguage']) {
    check(`${key} is present`, key in (learning ?? {}), true);
  }
  check('the word lists are offered', Array.isArray(learning?.listOptions), true);
  check('and the levels of the chosen list', Array.isArray(learning?.thresholdOptions), true);
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

  // A sender is required now: the worker needs to know which tab reported, so it
  // can ignore playback from a YouTube tab the user is not looking at.
  listeners.message[0](
    { target: 'background', type: 'content-position', index: 1, seconds: 2.5 },
    { tab: { id: 1 } },
  );
  await settle();

  check('panel received a position', received.at(-1)?.type, 'position');
  check('with the index', received.at(-1)?.index, 1);
  check('with the offset', received.at(-1)?.seconds, 2.5);
}

section('playback from a background YouTube tab is ignored');

{
  // The panel shows the active tab. A second YouTube tab also reports its
  // playback, and relaying that would move the highlight against a transcript it
  // does not belong to.
  const { listeners, received } = await boot(TRACK(GERMAN));
  const before = received.length;

  listeners.message[0](
    { target: 'background', type: 'content-position', index: 9, seconds: 99 },
    { tab: { id: 7 } }, // a different tab
  );
  await settle();

  check('nothing was relayed', received.length, before);
}

// --- 8. Degraded cases ------------------------------------------------------

section('a video with no captions still reports its title');

{
  const { received } = await boot(
    TRACK(GERMAN, { video: { ...VIDEO, trackList: [] }, provide: { ok: false, error: 'This video has no captions.' } }),
  );

  const state = received.at(-1)?.state;
  check('error surfaced', state?.error, 'This video has no captions.');
  check('title still shown', state?.title, 'Test Video');
  check('no rows', state?.rows?.length, 0);
}

// --- 9. Caching (the panel follows the active tab) ---------------------------

section('a video already cached is not fetched again');

{
  // This is what makes switching between YouTube tabs instant. The worker asks
  // the tab what it is showing first, and if that video is already in hand it
  // never asks for a download.
  const { calls, sendFromPanel, received } = await boot(TRACK(GERMAN));

  const provides = () => calls.sendMessage.filter((c) => c?.message?.type === 'provide').length;
  const afterBoot = provides();
  check('the first visit fetched once', afterBoot, 1);

  // Ask again, the way switching away and back would.
  sendFromPanel({ type: 'refresh' });
  await settle();

  check('the second visit fetched nothing new', provides(), afterBoot);
  check('rows are still shown', received.at(-1)?.state?.rows?.length, 3);
  check('from the cache, not a fetch', received.at(-1)?.state?.rows?.[0]?.text, 'Hey there');
}

section('switching to a different video fetches that one, and keeps the first cached');

{
  // Two videos in one worker, to prove the cache is keyed by video rather than
  // being one slot that the second video would evict. This is the same-tab
  // switch that used to leave the previous transcript on screen.
  const STUB_SWAP = 'zzzzzzzzzzz';
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDE_OK,
    trackPayload: GERMAN,
  });

  const provides = () => stub.calls.sendMessage.filter((c) => c?.message?.type === 'provide').length;
  check('the first video fetched once', provides(), 1);
  check('and is on screen', stub.received.at(-1)?.state?.videoId, 'dQw4w9WgXcQ');

  // The user switches video in the same tab.
  stub.setAnswer('describePayload', DESCRIBE({ ...VIDEO, videoId: STUB_SWAP, title: 'Second Video' }));
  stub.setAnswer('providePayload', {
    ok: true,
    video: { ...VIDEO, videoId: STUB_SWAP, title: 'Second Video' },
    requested: 'en',
    fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: 'Second content' }] },
  });

  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  check('the panel followed to the new video', stub.received.at(-1)?.state?.videoId, STUB_SWAP);
  check('and reported its title', stub.received.at(-1)?.state?.title, 'Second Video');
  check('showing the new transcript, not the old one', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Second content');
  check('which cost one more fetch', provides(), 2);

  // Go back to the first video: it should come straight from the cache.
  stub.setAnswer('describePayload', DESCRIBE(VIDEO));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  check('going back reuses the cache', provides(), 2);
  check('and shows the original transcript', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hey there');
}

section('a non-YouTube tab is reported rather than crashed on');

{
  const { received } = await boot({ tabs: [{ id: 1, active: true, url: 'https://example.com/' }] });
  check('an error is shown', typeof received.at(-1)?.state?.error, 'string');
  check('no rows', received.at(-1)?.state?.rows?.length, 0);
}

// --- 10. The learning layer --------------------------------------------------

section('the panel is told which word lists exist, and a default is chosen');

{
  const { received } = await boot(TRACK(GERMAN));

  // The dictionary loads at startup so the controls can be populated without
  // the learner waiting on a 1.4MB fetch when they open the panel.
  await settle();

  const state = received.at(-1)?.state;
  const lists = state?.lists ?? [];
  check('both HSK numberings are offered', lists.length, 2);
  check('with the 2.0 list', lists[0]?.id, 'hsk2_0');
  check('and the 3.0 list', lists[1]?.id, 'hsk3_0');
  check('each declares its level count', lists[0]?.levelCount, 6);
  check('and 3.0 declares nine', lists[1]?.levelCount, 9);

  // The default must be the list that can mark the most, not whichever is first
  // in the data. HSK 2.0 places 4,993 of 11,470 words; the other 6,477 exist
  // only in 3.0, so defaulting to 2.0 makes most of the dictionary silently
  // invisible — which looks exactly like the highlighting being broken.
  check('the widest list is chosen by default', state?.learning?.listId, 'hsk3_0');
  // The learner studies HSK 4, so marking starts there until told otherwise.
  check('threshold defaults to 4', state?.learning?.threshold, 4);
}

section('the default list is the one that can mark the most words');

{
  const { received } = await boot(TRACK(GERMAN));

  const lists = received.at(-1)?.state?.lists ?? [];
  const chosen = lists.find((l) => l.id === received.at(-1)?.state?.learning?.listId);
  const widest = [...lists].sort((a, b) => (b.levelled ?? 0) - (a.levelled ?? 0))[0];

  check('the chosen list is the widest', chosen?.id, widest?.id);
  check('which places real words', chosen?.levelled > 9000, true);
}

section('a word only the 3.0 list knows is still marked by default');

{
  // 早安 is the case the user reported. It is not a headword, so it segments
  // into 早 and 安 — and neither has an HSK 2.0 level, so under that list both
  // stayed blank. Both are levelled in 3.0 (1 and 4), so the default list has to
  // be 3.0 for the marks to appear at all.
  const { received } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: '早安' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  const row = received.at(-1)?.state?.rows?.[0];
  const texts = row?.tokens?.map((t) => t.text) ?? [];
  check('早安 breaks into its characters', texts, ['早', '安']);

  // Which of the two is marked depends on the threshold, and the default is 4.
  // 早 is HSK 3.0 level 1 and 安 is level 4, so exactly one should be marked —
  // the one at the learner's frontier. This is the "surface the unknown"
  // behaviour working: the known character stays quiet.
  const byText = Object.fromEntries((row?.tokens ?? []).map((t) => [t.text, t.level]));
  check('the level-1 character stays unmarked', byText['早'], null);
  check('the level-4 character is marked', byText['安'], 4);
  check('exactly one of the two is marked', row?.tokens?.filter((t) => t.level !== null).length, 1);
}

section('rows carry tokens, and only words at or beyond the threshold are marked');

{
  const { received } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: {
        languageCode: 'en',
        // 我 is HSK 2.0 level 1, 们 is level 1, 岸上 is high. The threshold is 4,
        // so the early characters must stay unmarked.
        segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }],
      },
    },
    trackPayload: GERMAN,
  });

  await waitForMarks(received);

  const row = received.at(-1)?.state?.rows?.[0];
  check('the row has tokens', Array.isArray(row?.tokens), true);
  check('tokens reconstruct the line', row.tokens.map((t) => t.text).join(''), '我们在岸上等你');

  const marked = row.tokens.filter((t) => t.level !== null);
  const unmarked = row.tokens.filter((t) => t.level === null);
  check('some tokens are marked', marked.length > 0, true);
  check('and some are not, since they are below the threshold', unmarked.length > 0, true);

  // 我们 is HSK 2.0 level 1, so at threshold 4 it must stay unmarked. Note the
  // token is the whole word, not 我 and 们 separately — longest match prefers
  // the compound, which is why an assertion about a bare character would be
  // asking about a token that does not exist.
  const early = row.tokens.find((t) => t.text === '我们');
  check('the compound segmenter produced exists as a token', Boolean(early), true);
  check('a level-1 word is not marked at threshold 4', early?.level, null);
  check('every mark is at or above the threshold', marked.every((t) => t.level >= 4), true);
}

section('lowering the threshold marks more');

{
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  const high = received.at(-1).state.rows[0].tokens.filter((t) => t.level !== null).length;

  sendFromPanel({ type: 'set-threshold', threshold: 1 });
  // A threshold change re-marks, and the tokens carried over from the previous
  // marking mean "every row has tokens" is already true — so this has to wait
  // for the number of marks to actually move, not for tokens to exist.
  const lowState = await waitForState(
    received,
    (s) => (s.rows?.[0]?.tokens ?? []).filter((t) => t.level !== null).length !== high,
    'the lower threshold to re-mark',
  );

  const low = lowState.rows[0].tokens.filter((t) => t.level !== null).length;
  check('a lower threshold marks at least as many', low >= high, true);
  check('and strictly more in this case', low > high, true);
  check('the threshold was reported back', received.at(-1).state.learning.threshold, 1);
}

section('a word the list cannot place is still hoverable, just unmarked');

{
  // The reported bug: "the whole zhe yang le didn't get highlighted". 这样 and
  // 这么 have no HSK 2.0 level at all — they are HSK 3.0 level 2 — so on HSK 2.0
  // they carried no mark. Rendering unmarked tokens as bare text then meant no
  // span, so no hover either, and a whole sentence looked dead.
  //
  // A word can be known, definable, and simply absent from the list in use. That
  // is "definition yes, colour no", not "invisible".
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: '你这样说了吗' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  // Choose HSK 2.0 explicitly, the list the bug was reported on.
  sendFromPanel({ type: 'set-list', listId: 'hsk2_0' });
  await waitForState(
    received,
    (s) => s.learning?.listId === 'hsk2_0',
    'the HSK 2.0 list to be adopted',
  );
  // Adopting the list happens before the re-mark, so wait for the tokens too.
  const inTwo = await waitForState(
    received,
    (s) => (s.rows?.[0]?.tokens ?? []).some((t) => t.text === '这样'),
    'the transcript to be segmented',
  );

  const row = inTwo.rows?.[0];
  const byText = Object.fromEntries((row?.tokens ?? []).map((t) => [t.text, t]));

  check('这样 is a token', Boolean(byText['这样']), true);
  check('it is marked as definable', byText['这样']?.defined, true);
  check('but carries no level in HSK 2.0', byText['这样']?.level, null);
  check('so the panel can still make it hoverable', byText['这样']?.defined && byText['这样']?.level === null, true);

  // The contrast needs a word that is above the threshold in one list and
  // absent from the other, so the same text marks differently. 挨着 is HSK 3.0
  // level 6; HSK 2.0 does not place it at all. (这样 would not work: it is HSK
  // 3.0 level 2, which is below the default threshold of 4, so it is correctly
  // unmarked in both lists — a reminder that "no level" and "below threshold"
  // both render as unmarked and only the `defined` flag distinguishes them.)
  sendFromPanel({ type: 'set-list', listId: 'hsk3_0' });
  const back = await waitForState(
    received,
    (s) => s.learning?.listId === 'hsk3_0',
    'the HSK 3.0 list to be re-adopted',
  );

  const row3 = back.rows?.[0];
  const byText3 = Object.fromEntries((row3?.tokens ?? []).map((t) => [t.text, t]));

  check('这样 is definable in every list', byText3['这样']?.defined, true);
  check('and is below the threshold, so unmarked', byText3['这样']?.level, null);

  // Words below the threshold must stay hoverable too, not only words the list
  // omits entirely.
  check('a below-threshold word is still definable', byText3['你']?.defined, true);
  check('with no level shown', byText3['你']?.level, null);
}

section('the same word marks differently in the two lists');

{
  // 挨着 is HSK 3.0 level 6 and absent from HSK 2.0 entirely. At threshold 4 it
  // must be marked under 3.0 and unmarked under 2.0 — while remaining hoverable
  // in both, which is the bug that was reported.
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: '他挨着我' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  const levelFor = (state) =>
    Object.fromEntries((state.rows?.[0]?.tokens ?? []).map((t) => [t.text, t]))['挨着'];

  // The list is already HSK 3.0 by default, so switching to it changes nothing
  // and there is no way to tell the re-mark apart from the one already done.
  // Wait on the LEVEL instead, which is what this test is actually about: 挨着
  // is level 6 under 3.0.
  const inThree = await waitForState(
    received,
    (s) => levelFor(s)?.level === 6,
    '挨着 to be marked level 6 under HSK 3.0',
  );
  check('marked in HSK 3.0', inThree ? levelFor(inThree)?.level : null, 6);
  check('and definable', levelFor(inThree)?.defined, true);

  sendFromPanel({ type: 'set-list', listId: 'hsk2_0' });
  const inTwo = await waitForState(
    received,
    (s) => levelFor(s)?.level === null && s.learning?.listId === 'hsk2_0',
    '挨着 to lose its level under HSK 2.0',
  );
  check('unmarked in HSK 2.0', levelFor(inTwo)?.level, null);
  check('but still definable, so hover still works', levelFor(inTwo)?.defined, true);
}

section('a word we cannot define stays plain text');

{
  // The other side of the same distinction: an unknown word has nothing to show,
  // so it must not become an interactive span that does nothing.
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: '囍嚻' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  const tokens = received.at(-1)?.state?.rows?.[0]?.tokens ?? [];
  check('both characters are tokens', tokens.length, 2);
  check('neither is definable', tokens.every((t) => !t.defined), true);
  check('and neither carries a level', tokens.every((t) => t.level === null), true);
}

section('opening the panel mid-video knows where playback is');

{
  // The reported bug: on an ongoing video, Follow is ticked but the transcript
  // does not start at the live line. POSITION is an *event* — the content script
  // fires it once per cue change and dedupes — so a panel that opens afterwards
  // never hears about the cue already playing, and sits at the top until the
  // next change, which on a paused video never comes.
  //
  // Position therefore has to be part of the state, not only an event.
  const stub = await boot(TRACK(GERMAN));
  const { received, listeners } = stub;
  await waitForFirstState(received);

  // The content script reports a cue while the panel is attached.
  listeners.message[0](
    { target: 'background', type: 'content-position', index: 2, seconds: 60 },
    { tab: { id: 1 } },
  );
  await settle();
  check('the panel is told about a cue change', received.at(-1)?.type, 'position');

  // Now the panel goes away and the SAME worker is reopened — booting again
  // would build a fresh worker with fresh state, which is not what reopening a
  // panel does and would make this test prove nothing.
  stub.disconnect();
  const reopened = stub.reopen();
  await waitForFirstState(reopened.received);

  const state = reopened.received.at(-1)?.state;
  check('and a newly opened panel is told where playback is', state?.activeIndex, 2);
}

section('the reported cue survives the panel not being there');
{
  // A stronger form of the same thing: the report can arrive while no panel is
  // attached at all, since the content script keeps polling regardless. It still
  // has to be remembered, or the next panel opens blind.
  const stub = await boot(TRACK(GERMAN));
  await waitForFirstState(stub.received);

  stub.disconnect();
  stub.listeners.message[0](
    { target: 'background', type: 'content-position', index: 1, seconds: 30 },
    { tab: { id: 1 } },
  );
  await settle();

  const again = stub.reopen();
  await waitForFirstState(again.received);
  check('a cue reported while the panel was closed is remembered', again.received.at(-1)?.state?.activeIndex, 1);
}

section('a cue from a background tab is neither relayed nor remembered');

{
  // Position is per-tab. A YouTube tab the user is not watching also reports its
  // playback, and adopting its index would highlight the wrong line.
  const { received, listeners } = await boot(TRACK(GERMAN));
  await waitForFirstState(received);

  // The first test block needs the stub handle too, so this one keeps its own.
  check('a cue is remembered as -1 until reported', received.at(-1)?.state?.activeIndex, -1);

  listeners.message[0](
    { target: 'background', type: 'content-position', index: 7, seconds: 99 },
    { tab: { id: 42 } }, // not the tracked tab
  );
  await settle();

  check('a cue from another tab is ignored', received.at(-1)?.state?.activeIndex, -1);
}

section('switching video clears the remembered cue');

{
  // An index is only meaningful against the transcript it was measured on. Two
  // transcripts have different lengths, so carrying an index across would
  // highlight an unrelated line — or run off the end.
  const stub = await boot(TRACK(GERMAN));
  await waitForFirstState(stub.received);

  stub.listeners.message[0](
    { target: 'background', type: 'content-position', index: 2, seconds: 60 },
    { tab: { id: 1 } },
  );
  await settle();
  // A cue report is a `position` message, not a `state` one — it carries `index`
  // rather than `state.activeIndex`. Asking the worker for state afterwards is
  // what shows the cue was remembered as well as relayed.
  check('the cue arrived as a position event', stub.received.at(-1)?.index, 2);

  stub.sendFromPanel({ type: 'refresh' });
  await waitForState(stub.received, (s) => s.activeIndex === 2, 'the cue to reach the state');
  check('and it is part of the state', stub.received.at(-1)?.state?.activeIndex, 2);

  stub.setAnswer('describePayload', DESCRIBE({ ...VIDEO, videoId: 'othervid001', title: 'Other' }));
  stub.setAnswer('providePayload', {
    ok: true,
    video: { ...VIDEO, videoId: 'othervid001', title: 'Other' },
    requested: 'en',
    fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: 'Different' }] },
  });

  stub.sendFromPanel({ type: 'refresh' });
  await waitForState(stub.received, (s) => s.videoId === 'othervid001', 'the new video to be adopted');

  check('the new video starts with no cue', stub.received.at(-1)?.state?.activeIndex, -1);
}

section('switching language keeps the marks');

{
  // The other reported bug. Choosing a second subtitle track rebuilds the rows,
  // which discarded the tokens — and because the "already marked" flag was still
  // set, nothing re-attached them. The transcript came back unmarked until a
  // learning control was touched by hand, which changed the flag and forced it.
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
    },
    trackPayload: {
      languageCode: 'de',
      segments: [{ start: 0, duration: 2, text: 'Wir warten am Ufer' }],
    },
  });

  const before = await waitForMarks(received);
  const markedBefore = before.rows[0].tokens.filter((t) => t.level !== null).length;
  check('marked to begin with', markedBefore > 0, true);

  // Choose a second subtitle language, which rebuilds every row. The marks have
  // to survive that — the bug was that the rebuild discarded the tokens while
  // the "already marked" flag stayed set, so nothing re-attached them.
  sendFromPanel({ type: 'set-secondary', languageCode: 'de' });
  const after = await waitForState(
    received,
    (s) => Boolean(s.rows?.[0]?.secondary?.length),
    'the second language to arrive',
  );

  const row = after.rows[0];
  check('the second language arrived', row.secondary.length > 0, true);
  check('the text is unchanged', row.text, '我们在岸上等你');
  check('and the marks survived', row.tokens.filter((t) => t.level !== null).length, markedBefore);
}

section('switching word list re-marks rather than reusing the old levels');

{
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  sendFromPanel({ type: 'set-list', listId: 'hsk3_0' });
  const state = await waitForState(
    received,
    (s) => s.learning?.listId === 'hsk3_0',
    'the HSK 3.0 list to be adopted',
  );

  check('the list changed', state.learning.listId, 'hsk3_0');
  // Levels are numbered differently between the lists, so a threshold cannot be
  // carried across: 4 means something else in a 9-level list.
  check('the threshold was reset for the new list', state.learning.threshold, 4);
  check('rows were rebuilt', Array.isArray(state.rows[0]?.tokens), true);
}

section('marks appear without the learner having to touch the controls');

{
  // The reported bug: subs render, but no highlighting until a dropdown is
  // changed by hand. Changing a control calls rebuildRows, so the symptom means
  // the marks were never applied on their own — the dictionary finished loading
  // and nothing re-marked the rows that were already on screen.
  const { received } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
    },
    trackPayload: GERMAN,
  });

  // Wait for the marks themselves, which is what this test is about — the bug
  // was that the dictionary loaded and nothing re-marked the rows already on
  // screen. A fixed sleep here was both slower and a guess.
  const state = await waitForState(
    received,
    (s) => (s.rows?.[0]?.tokens ?? []).some((t) => t.level !== null),
    'the marks to appear without any control being touched',
  );

  const row = state.rows?.[0];
  check('the row ended up with tokens', Array.isArray(row?.tokens), true);
  check('and at least one is marked', row?.tokens?.some((t) => t.level !== null), true);
  check(
    'without any control being touched',
    received.some((m) => m.type === 'state' && m.state?.rows?.[0]?.tokens?.some((t) => t.level !== null)),
    true,
  );
}

{
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'en',
      fetched: { languageCode: 'en', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  sendFromPanel({ type: 'lookup', word: '我们' });
  const reply = await waitForMessage(received, (m) => m.type === 'entry', 'the definition reply');

  check('an entry was sent back', reply?.type, 'entry');
  check('for the word asked about', reply?.word, '我们');
  check('with a definition', typeof reply?.entry?.m, 'string');
  check('and pinyin', typeof reply?.entry?.p, 'string');
  check('and every list that places it', Array.isArray(reply?.levels), true);
}

section('a word with no level still gets a definition');

{
  const { received, sendFromPanel } = await boot(TRACK(GERMAN));

  // The user's own instruction: unlevelled words should still be looked up,
  // they simply carry no HSK colour or badge.
  sendFromPanel({ type: 'lookup', word: '囍' });
  const reply = await waitForMessage(received, (m) => m.type === 'entry', 'the definition reply');

  check('an entry was sent', reply?.type, 'entry');
  check('it has no levels', reply?.levels?.length, 0);
  check('and no dictionary entry either, so entry is null', reply?.entry, null);
}

// --- Result -----------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
