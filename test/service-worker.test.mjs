/**
 * Boots the service worker against a chrome stub and drives it the way the
 * browser would. Run with `npm test`.
 *
 * The value here is not coverage, it is that the worker is *evaluated*. Static
 * checks prove imports and names line up; only running the module proves it does
 * not throw on the way up, which is the failure that makes the panel sit on its
 * placeholder with nothing to go on.
 *
 * Every section boots a fresh worker against its own stub. `chrome` is a single
 * global that each install replaces, so sharing one stub across sections means a
 * later install silently redirects an earlier section's calls.
 */

import { installChromeStub, createPanelPort } from './chrome-stub.mjs';
import { fixture } from './synthetic/load.mjs';
import { readFileSync } from 'node:fs';

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
 * 3.5s of a 3.9s suite. A sleep is a guess in both directions, too short and the
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
 * marking, this would return immediately and hand back stale levels. Waiting
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
 * evaluation of the worker, which is what makes the sections independent.
 *
 * @param {object} [options] Passed through to installChromeStub.
 * @returns {Promise<{listeners: object, calls: object, storage: object, received: object[], sendFromPanel: Function, disconnect: Function}>}
 */
async function boot(options = {}) {
  const stub = installChromeStub(options);
  await import(`../src/background/service-worker.js?boot=${++bootCount}`);

  const panel = connectPanel(stub);

  // Startup is finished when the state names the lists, which it can only do
  // AFTER the index has been read.
  //
  // This used to be a single `await settle()`, one macrotask, and the worker's
  // startup is deeper than that: it reads settings, registers open tabs, reads
  // the index, then broadcasts. Whether one turn was enough depended on how many
  // microtasks those awaits took, which differs between Node releases, so the
  // suite passed on Node 26 and failed on the Node 22 that CI pins.
  //
  // Waiting for the CONDITION is the same rule the browser tier already follows,
  // and it removes the version dependence rather than hiding it behind a count
  // of turns.
  await waitForState(panel.received, (state) => (state.lists?.length ?? 0) > 0, 'the list index to load');

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
 * what reopening a panel does, the worker persists and only the port
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

/**
 * The primary track.
 *
 * Chinese, because the bundled word list is Chinese and the marking gate refuses a
 * line no list covers. An English fixture here would be refused before marking ran,
 * so every marking assertion would fail for a reason unrelated to what it tests,
 * which is exactly what happened when this was English text.
 */
const CHINESE = {
  languageCode: 'zh-Hans',
  segments: [
    { start: 0, duration: 2, text: '大家早安' },
    { start: 2, duration: 2, text: '你好吗' },
    { start: 4, duration: 2, text: '欢迎回来' },
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
    { languageCode: 'zh-Hans', name: 'Chinese (Simplified)', kind: null, isTranslatable: true },
    { languageCode: 'de', name: 'Deutsch', kind: null, isTranslatable: true },
  ],
  // The translate menu, per video. Note `en` is offered even though it is also a
  // track: YouTube lists the source among its own targets.
  translationLanguages: [
    { languageCode: 'zh-Hans', name: 'Chinese (Simplified)' },
    { languageCode: 'en', name: 'English' },
    { languageCode: 'ja', name: 'Japanese' },
    { languageCode: 'ko', name: 'Korean' },
  ],
};

const PROVIDE_OK = { ok: true, video: VIDEO, requested: 'zh-Hans', fetched: CHINESE };

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
  check('primary defaulted to the fetched track', state?.study, 'zh-Hans');
  check('secondary is opt-in, so null', state?.gloss, null);
  check('no error reported', state?.error, null);
  check('rows were built', state?.rows?.length, 3);
  check('a row has text', state?.rows?.[0]?.text, '大家早安');
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

  sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  await settle();

  const state = received.at(-1)?.state;
  check('secondary recorded', state?.gloss, 'de');
  check('still one row per primary cue', state?.rows?.length, 3);
  check('first pair', state?.rows?.[0]?.secondary, 'Hallo');
  check('second pair', state?.rows?.[1]?.secondary, 'wie geht es dir');
  check('third pair', state?.rows?.[2]?.secondary, 'willkommen zurueck');
  check('choice was persisted', storage.settings?.glossLanguage, 'de');
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
  if (!segments) return { ok: false, error: 'VIDEO001 This video has no captions.' };

  const translateTo = request?.translateTo ?? null;
  if (translateTo) {
    const track = video.trackList.find((t) => t.languageCode === languageCode);
    // A track that cannot be translated is refused rather than served
    // untranslated, which is what the real content script does.
    if (track && track.isTranslatable === false) {
      return { ok: false, error: 'TRACK001 This caption track cannot be auto-translated.', fetched: { languageCode, translateTo: null, segments: [], error: 'TRACK001 This caption track cannot be auto-translated.' } };
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

const SEGMENTS = { 'zh-Hans': CHINESE.segments, de: GERMAN.segments };

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

  stub.sendFromPanel({ type: 'set-study', languageCode: 'de' });
  await settle();
  check('primary chosen', stub.received.at(-1)?.state?.study, 'de');
  check('and the German lines are on screen', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hallo');

  // Same tab, different video, same two tracks available.
  stub.setAnswer('describePayload', DESCRIBE(secondVideo));
  stub.setAnswer('providePayload', PROVIDER(secondVideo, SEGMENTS));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  check('the new video is on screen', stub.received.at(-1)?.state?.videoId, 'zzzzzzzzzzz');
  check('and it kept the chosen language', stub.received.at(-1)?.state?.study, 'de');
  check('so the German lines are still shown', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hallo');
}

section('a language choice is kept for the video that has it, and restored later');

{
  // A video that lacks the chosen track must fall back rather than fail, but
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

  stub.sendFromPanel({ type: 'set-study', languageCode: 'de' });
  await settle();

  stub.setAnswer('describePayload', DESCRIBE(portugueseOnly));
  stub.setAnswer('providePayload', PROVIDER(portugueseOnly, { pt: [{ start: 0, duration: 2, text: 'Ola' }] }));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  check('the video without the language falls back', stub.received.at(-1)?.state?.study, 'pt');
  check('and shows what it does have', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Ola');
  check('but the preference is remembered', stub.storage.settings?.studyLanguage, 'de');

  // Back to a video that has German: the choice comes back on its own.
  stub.setAnswer('describePayload', DESCRIBE(VIDEO));
  stub.setAnswer('providePayload', PROVIDER(VIDEO, SEGMENTS));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  check('returning to a video with the language restores it', stub.received.at(-1)?.state?.study, 'de');
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

  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  await settle();

  stub.setAnswer('describePayload', DESCRIBE(secondVideo));
  stub.setAnswer('providePayload', PROVIDER(secondVideo, SEGMENTS));
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  const state = stub.received.at(-1)?.state;
  check('primary stayed', state?.study, 'zh-Hans');
  check('secondary stayed', state?.gloss, 'de');
  check('and paired rows are still produced', state?.rows?.[0]?.secondary, 'Hallo');
}

// --- 3d. Auto-translate ------------------------------------------------------

/**
 * Turn on translation for the gloss line.
 *
 * Two settings, deliberately: the TARGET is global because it is a preference
 * you set once, and the per-line bit is what varies. Sent as one call because
 * either alone does nothing.
 *
 * @param {object} stub
 * @param {string} target
 */
const translateGloss = (stub, target) => {
  stub.sendFromPanel({ type: 'set-setting', id: 'glossTranslated', value: true });
  stub.sendFromPanel({ type: 'set-setting', id: 'translateInto', value: target });
};

section('translating the second line shows machine text there, and only there');

{
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  await settle();
  check('the untranslated gloss is on screen first', stub.received.at(-1)?.state?.rows?.[0]?.secondary, 'Hallo');

  translateGloss(stub, 'ja');
  await settle();

  const state = stub.received.at(-1)?.state;
  check('the gloss is translated', state?.rows?.[0]?.secondary, '[ja] Hallo');
  // The study line is never machine translated: it is the text being learned, and
  // the marks and definitions describe it. Translating it would put a studiable
  // overlay on a text the learner cannot see.
  check('and the study line is untouched', state?.rows?.[0]?.text, '大家早安');
  // The cache is keyed on the SOURCE track, so this must not have become a `ja`
  // track, that would collide with a real Japanese track on the same video.
  check('the gloss language is still the source', state?.gloss, 'de');
  check('and the target is reported apart from it', state?.glossTranslation, 'ja');
  check('no error', state?.error, null);
}

section('the study line is not translated even when the gloss is');

{
  // A rule rather than a preference. The old model allowed it, because a
  // translation was a property of a slot and the first slot was always the study
  // line, which is how a machine translation ended up wearing HSK marks.
  //
  // The gloss is deliberately the SAME language as the study line, so a
  // translation IS happening and the only question is which line it lands on.
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'zh-Hans' });
  await settle();
  translateGloss(stub, 'ja');
  await settle();

  const state = stub.received.at(-1)?.state;
  check('the gloss is translated', state?.rows?.[0]?.secondary, '[ja] 大家早安');
  check('and the study line is not', state?.rows?.[0]?.text, '大家早安');
  check('nothing reports the study line as translated', state?.studyTranslation, null);
}

section('the translate menu comes from the video, and excludes the source language');

{
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  const state = stub.received.at(-1)?.state;
  check('the languages are offered', state?.translationLanguages?.length, 4);
  check('with their codes', state?.translationLanguages?.map((l) => l.languageCode), ['zh-Hans', 'en', 'ja', 'ko']);
  // Translating a track into itself does nothing, so the panel must be able to
  // filter it out rather than offering an entry with no effect.
  // The video offers the source language among its targets, which is why the PANEL
  // has to filter it out rather than the data doing so.
  check('the video itself offers the source language', state?.translationLanguages?.some((l) => l.languageCode === state.study), true);
}

section('unticking the box refetches rather than keeping the translation');

{
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  await settle();
  translateGloss(stub, 'ja');
  await settle();
  check('translated', stub.received.at(-1)?.state?.rows?.[0]?.secondary, '[ja] Hallo');

  stub.sendFromPanel({ type: 'set-setting', id: 'glossTranslated', value: false });
  await settle();

  const state = stub.received.at(-1)?.state;
  check('back to the original text', state?.rows?.[0]?.secondary, 'Hallo');
  check('and nothing is reported as translated', state?.glossTranslation, null);
  // The target is a preference and survives: unticking is "not now", not "forget
  // which language I read in".
  check('the target is remembered', state?.translateInto, 'ja');
}

section('a translation survives moving to another video');

{
  // Same stickiness as the language choices: the preferences are global, and the
  // rendering is per video.
  const secondVideo = { ...VIDEO, videoId: 'zzzzzzzzzzz', title: 'Second Video' };
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: PROVIDER(VIDEO, SEGMENTS),
    trackPayload: TRACK_FETCHER(VIDEO, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  await settle();
  translateGloss(stub, 'ja');
  await settle();
  check('translated to start', stub.received.at(-1)?.state?.rows?.[0]?.secondary, '[ja] Hallo');

  stub.setAnswer('describePayload', DESCRIBE(secondVideo));
  stub.setAnswer('providePayload', PROVIDER(secondVideo, SEGMENTS));
  // The second video is seeded from the same preferences, so the gloss choice has
  // to be re-seeded or the translation would have nothing to apply to.
  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  const state = stub.received.at(-1)?.state;
  check('the new video is on screen', state?.videoId, 'zzzzzzzzzzz');
  check('and its gloss is translated too', state?.rows?.[0]?.secondary, '[ja] Hallo');
}

section('a gloss that cannot be translated falls back to the original');

{
  // The important one. A translation is a nice-to-have; the transcript is not.
  // Asking for a translation a video cannot produce must not blank the screen or
  // wipe the transcript from the cache.
  const untranslatable = {
    ...VIDEO,
    trackList: [
      { languageCode: 'zh-Hans', name: 'Chinese (Simplified)', kind: 'asr', isTranslatable: true },
      { languageCode: 'de', name: 'Deutsch', kind: null, isTranslatable: false },
    ],
  };
  const stub = await boot({
    describePayload: DESCRIBE(untranslatable),
    providePayload: PROVIDER(untranslatable, SEGMENTS),
    trackPayload: TRACK_FETCHER(untranslatable, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  await settle();
  translateGloss(stub, 'ja');
  await settle();

  const state = stub.received.at(-1)?.state;
  check('the original gloss text is still on screen', state?.rows?.[0]?.secondary, 'Hallo');
  check('with no translation applied', state?.glossTranslation, null);
  check('and the reason is reported', String(state?.error ?? '').includes('translat'), true);

  // And it recovers: unticking clears the message.
  stub.sendFromPanel({ type: 'set-setting', id: 'glossTranslated', value: false });
  await settle();
  check('clearing it clears the error', stub.received.at(-1)?.state?.error, null);
  check('and the transcript is intact', stub.received.at(-1)?.state?.rows?.[0]?.text, '大家早安');
}

section('a cached track still refetches when the translation target changed');
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

  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  await settle();
  translateGloss(stub, 'ja');
  await settle();
  check('translated to Japanese', stub.received.at(-1)?.state?.rows?.[0]?.secondary, '[ja] Hallo');

  // Switch target. The track is cached; the rendering is not.
  stub.sendFromPanel({ type: 'set-setting', id: 'translateInto', value: 'ko' });
  await settle();
  check('the new target is rendered', stub.received.at(-1)?.state?.rows?.[0]?.secondary, '[ko] Hallo');
  check('and reported', stub.received.at(-1)?.state?.glossTranslation, 'ko');

  // And the reverse: re-selecting the SAME target must not refetch.
  const before = stub.calls.sendMessage.filter((c) => c?.message?.type === 'fetch-track').length;
  stub.sendFromPanel({ type: 'set-setting', id: 'translateInto', value: 'ko' });
  await settle();
  const after = stub.calls.sendMessage.filter((c) => c.message?.type === 'fetch-track').length;
  check('re-selecting the same target does not refetch', after, before);
}

section('an untranslatable gloss is not asked again on every refresh');
{
  // The preference stays set, so without the translatability check every refresh
  // would re-request a translation that cannot exist, a wasted round trip and a
  // permanent error on screen.
  const untranslatable = {
    ...VIDEO,
    trackList: [
      { languageCode: 'zh-Hans', name: 'Chinese (Simplified)', kind: 'asr', isTranslatable: true },
      { languageCode: 'de', name: 'Deutsch', kind: null, isTranslatable: false },
    ],
  };
  const stub = await boot({
    describePayload: DESCRIBE(untranslatable),
    providePayload: PROVIDER(untranslatable, SEGMENTS),
    trackPayload: TRACK_FETCHER(untranslatable, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  await settle();
  translateGloss(stub, 'ja');
  await settle();

  const before = stub.calls.sendMessage.filter((c) => c?.message?.type === 'provide').length;
  stub.sendFromPanel({ type: 'refresh' });
  await settle();
  const after = stub.calls.sendMessage.filter((c) => c.message?.type === 'provide').length;

  check('the second refresh fetched nothing', after, before);
  check('the transcript is still shown', stub.received.at(-1)?.state?.rows?.[0]?.text, '大家早安');
}

section('one language on both lines: itself, and its translation');

{
  // The reported case. A video whose only subtitle is English, and the wish to
  // read English with a translation underneath it. "Off" cannot be translated,
  // a translation needs a source track to convert, so the gloss has to hold
  // English as well, and that is a legitimate state rather than a mistake.
  //
  // The cache was keyed by language code alone, so the translated fetch
  // OVERWROTE the untranslated one and both lines rendered the translation: the
  // original English was gone, which is what "both converted to Chinese" was.
  const chineseOnly = {
    ...VIDEO,
    trackList: [{ languageCode: 'zh-Hans', name: 'Chinese (Simplified)', kind: null, isTranslatable: true }],
  };
  const stub = await boot({
    describePayload: DESCRIBE(chineseOnly),
    providePayload: PROVIDER(chineseOnly, SEGMENTS),
    trackPayload: TRACK_FETCHER(chineseOnly, SEGMENTS),
  });

  stub.sendFromPanel({ type: 'set-gloss', languageCode: 'zh-Hans' });
  await settle();

  check('the same language can be the second line as well as the first', stub.received.at(-1)?.state?.gloss, 'zh-Hans');
  check('with both lines showing the untranslated text', stub.received.at(-1)?.state?.rows?.[0]?.secondary, '大家早安');

  translateGloss(stub, 'ko');
  await settle();

  const state = stub.received.at(-1)?.state;
  // The point of the whole arrangement: one line original, one line translated.
  check('the study line stays the original', state?.rows?.[0]?.text, '大家早安');
  check('and only the gloss is translated', state?.rows?.[0]?.secondary, '[ko] 大家早安');
  // Every row, not just the first, a collision would affect all of them.
  check('the last row keeps its original too', state?.rows?.[2]?.text, '欢迎回来');
  check('and its translation', state?.rows?.[2]?.secondary, '[ko] 欢迎回来');

  // Untick, and the two renderings still differ, so the cache has to keep
  // holding both at once.
  stub.sendFromPanel({ type: 'set-setting', id: 'glossTranslated', value: false });
  await settle();

  const untranslated = stub.received.at(-1)?.state;
  check('unticking restores the original gloss', untranslated?.rows?.[0]?.secondary, '大家早安');
  check('with the study line unchanged throughout', untranslated?.rows?.[0]?.text, '大家早安');
}

// --- 3c. Settings -----------------------------------------------------------

section('a cached video still hands its transcript to the content script');

{
  // The regression this pins: on a cache hit nothing is fetched, so the content
  // script was never given the segments it reports position FROM. A freshly
  // loaded page therefore reported no cue at all, and the panel sat at the top of
  // the transcript with nothing highlighted, no auto-scroll, no follow.
  //
  // Only visible from here: the content script's own suite calls set-track
  // directly, so it cannot see whether anything ever calls it.
  const stub = await boot(TRACK(GERMAN));
  const sends = () => stub.calls.sendMessage.filter((c) => c?.message?.type === 'set-track');
  check('nothing handed over before a cache hit', sends().length, 0);

  // Second refresh: the video is cached, so no fetch happens, which is exactly
  // when the hand-over has to occur.
  stub.sendFromPanel({ type: 'refresh' });
  await settle();

  const handed = sends();
  check('the transcript is handed over on the cached path', handed.length, 1);
  check('with the segments themselves', handed[0]?.message?.segments?.length, 3);
  // The id has to travel with them: the content script clears its segments when
  // it sees a different video, so without this the next tick wipes them.
  check('and the video they belong to', handed[0]?.message?.videoId, 'dQw4w9WgXcQ');
  check('sent to the content script, not the panel', handed[0]?.tabId, 1);
}

section('a hand-over that fails does not break the refresh');

{
  // A value that made sense when it was stored may not make sense now, a size
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
      settings: { view: 'focus', fontSize: 400, listId: 'nonsense', threshold: 2, studyLanguage: 'de' },
    },
    // Storage is slow enough that a panel connecting immediately, as it does in
    // reality, would otherwise be served before the restore finished.
    storageDelay: 5,
  });
  // The restore is deliberately slow here (storageDelay), and the first refresh
  // waits on it, so this waits for the restored value rather than for a
  // duration. Reading too early sees no state at all, not default settings.
  const learning = (
    await waitForState(stub.received, (s) => s.learning?.view === 'focus', 'the settings to be restored')
  ).learning;
  check('a valid setting is restored', learning?.view, 'focus');
  check('an absurd text size is clamped to the maximum', learning?.fontSize, 32);
  check('an unknown word list falls back', learning?.listId !== 'nonsense', true);
  check('and the restored language was applied', stub.received.at(-1)?.state?.study, 'de');
  check('and its lines were fetched, not the default ones', stub.received.at(-1)?.state?.rows?.[0]?.text, 'Hallo');
}

section('changing a setting is remembered');

{
  const stub = await boot(TRACK(GERMAN));

  stub.sendFromPanel({ type: 'set-setting', id: 'fontSize', value: 18 });
  await settle();

  check('it landed in storage', stub.storage.settings?.fontSize, 18);
  check('and is reflected in the state', stub.received.at(-1)?.state?.learning?.fontSize, 18);

  stub.sendFromPanel({ type: 'set-setting', id: 'view', value: 'focus' });
  await settle();
  check('a second setting is stored alongside', stub.storage.settings?.view, 'focus');
  check('without losing the first', stub.storage.settings?.fontSize, 18);

  // An unknown id should be ignored rather than written, so a panel from a newer
  // version cannot poison the stored object with keys nothing understands.
  stub.sendFromPanel({ type: 'set-setting', id: 'notASetting', value: 'x' });
  await settle();
  check('an unknown setting is ignored', 'notASetting' in (stub.storage.settings ?? {}), false);
  check('and a nonsense value is coerced, not stored raw', (() => {
    stub.sendFromPanel({ type: 'set-setting', id: 'fontSize', value: 'huge' });
    return true;
  })(), true);
  await settle();
  check('the nonsense size fell back to the default', stub.storage.settings?.fontSize, 13);
}

section('the choices a learner makes are all reported back in the learning block');

{
  const stub = await boot(TRACK(GERMAN));
  const learning = stub.received.at(-1)?.state?.learning;

  // The panel renders its controls from this block, so a missing key is a
  // control that silently never updates.
  for (const key of ['view', 'fontSize', 'listId', 'threshold', 'studyLanguage', 'glossLanguage']) {
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

  sendFromPanel({ type: 'set-gloss', languageCode: 'fr' });
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

  sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
  await settle();
  const afterFirst = count();

  sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
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
    TRACK(GERMAN, { video: { ...VIDEO, trackList: [] }, provide: { ok: false, error: 'VIDEO001 This video has no captions.' } }),
  );

  const state = received.at(-1)?.state;
  check('error surfaced', state?.error, 'VIDEO001 This video has no captions.');
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
  check('from the cache, not a fetch', received.at(-1)?.state?.rows?.[0]?.text, '大家早安');
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
    requested: 'zh-Hans',
    fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: 'Second content' }] },
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
  check('and shows the original transcript', stub.received.at(-1)?.state?.rows?.[0]?.text, '大家早安');
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
  // Three lists now: two HSK numberings and JLPT. The count is asserted because a
  // build that drops a language from the index would otherwise go unnoticed,
  // the dropdown would simply offer fewer choices, with nothing reporting it.
  check('every list from the index is offered', lists.length, 3);
  check('with the 2.0 list', lists[0]?.id, 'hsk2_0');
  check('and the 3.0 list', lists[1]?.id, 'hsk3_0');
  check('and the JLPT list', lists[2]?.id, 'jlpt');
  check('each declares its level count', lists[0]?.levelCount, 6);
  check('and 3.0 declares nine', lists[1]?.levelCount, 9);
  check('and JLPT declares five', lists[2]?.levelCount, 5);

  // The default must be the list that can mark the most, not whichever is first
  // in the data. HSK 2.0 places 4,993 of 11,470 words; the other 6,477 exist
  // only in 3.0, so defaulting to 2.0 makes most of the dictionary silently
  // invisible, which looks exactly like the highlighting being broken.
  //
  // And "most" is within the PRIMARY language. JLPT places more words than HSK
  // 3.0 (11,158 vs 10,969), so widest-overall made Japanese the default for a
  // fresh install, and on a Chinese video that list covers nothing, which is
  // the very symptom the widest-list rule exists to prevent.
  check('the widest list is chosen by default', state?.learning?.listId, 'hsk3_0');
  // Nothing is chosen yet, so marking starts at the FIRST level of the list,
  // everything marked until the learner narrows it. Asserted against the list's
  // own numbering rather than a literal, so the test does not encode a policy.
  //
  // This used to be the middle of the range, which is still the app deciding how
  // good a stranger is at a language it has never seen them read.
  check('marking starts at the first level when nothing is chosen', state?.learning?.threshold, 1);
  // The options are named by the list, so HSK reads 1..9. This is the check that
  // would have caught the JLPT badge printing an internal number as a name.
  check('the level options are named by the list', state?.learning?.thresholdOptions?.[0]?.label, '1');
  check('through to its top level', state?.learning?.thresholdOptions?.at(-1)?.label, '9');
  // The stored number is what the comparison uses; the label is what a person
  // reads. Keeping them separate is the whole point.
  check('with the option value still the internal number', state?.learning?.thresholdOptions?.[0]?.value, 1);
}

section('the default list is the one that can mark the most words');

{
  const { received } = await boot(TRACK(GERMAN));

  const lists = received.at(-1)?.state?.lists ?? [];
  const chosen = lists.find((l) => l.id === received.at(-1)?.state?.learning?.listId);
  // Widest WITHIN the default language, not widest overall, JLPT places more
  // words than any HSK list, and choosing it would leave a Chinese video unmarked.
  const primary = lists.filter((l) => l.language === lists[0]?.language);
  const widest = [...primary].sort((a, b) => (b.levelled ?? 0) - (a.levelled ?? 0))[0];

  check('the chosen list is the widest', chosen?.id, widest?.id);
  check('which places real words', chosen?.levelled > 9000, true);
}

section('switching to a Japanese list loads Japanese words and marks them');

{
  // The whole point of the second language, end to end through the worker. A
  // failure here is the one that would ship as "the JLPT option does nothing".
  const JAPANESE_VIDEO = {
    videoId: 'jaTestVideo',
    title: 'Japanese Test',
    isLive: false,
    trackList: [{ languageCode: 'ja', name: 'Japanese', kind: null, isTranslatable: true }],
    translationLanguages: [{ languageCode: 'ja', name: 'Japanese' }, { languageCode: 'en', name: 'English' }],
  };

  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(JAPANESE_VIDEO),
    providePayload: {
      ok: true,
      video: JAPANESE_VIDEO,
      requested: 'ja',
      fetched: { languageCode: 'ja', segments: [{ start: 0, duration: 2, text: '日本語を勉強します' }] },
    },
    trackPayload: GERMAN,
  });
  // Wait for the initial state before switching. `sendFromPanel` throws if the
  // worker has not subscribed to the port yet, and a switch sent before the
  // startup marking has settled is dropped, which looked like a marking bug
  // rather than a test that asked too early.
  await waitForState(received, (s) => Array.isArray(s.lists) && s.lists.length > 0, 'startup');
  await waitForState(received, (s) => s.learning?.listId !== null, 'a default list to be chosen');

  sendFromPanel({ type: 'set-list', listId: 'jlpt' });

  // Wait for the switch to take effect AND the rows to be tokenised, rather than
  // for a mark or a duration.
  const state = await waitForState(
    received,
    (s) => s.learning?.listId === 'jlpt' && Array.isArray(s.rows?.[0]?.tokens),
    'the Japanese list to tokenise a row',
  );

  check('the list is now JLPT', state.learning.listId, 'jlpt');
  // The learner has never chosen a level for JLPT, so it starts at the first.
  // NOT carried over from the Chinese list, and not a guessed "sensible" middle,
  // a threshold only means something against its own list's numbering.
  check('the Japanese list starts at its own first level, not a carried number', state.learning.threshold, 1);
  // `markedReason` lives on the STATE, not on a row, it explains the whole
  // transcript, not one line. Null means the list covers the language on screen.
  check('the list covers Japanese, so no reason is given', state.markedReason, null);

  const row = state.rows?.[0];
  const texts = (row?.tokens ?? []).map((t) => t.text);
  // 勉強 is a single JLPT word. If the Japanese dictionary had not loaded, the
  // text would segment into bare characters instead, this is the assertion that
  // distinguishes "words loaded" from "the row merely exists".
  check('the row segments into Japanese words, not bare characters', texts.includes('勉強'), true);

  // At the first level nothing is filtered out, so every word that HAS a level is
  // marked. The interesting half is the second assertion: a word with no level at
  // all is recognised but unmarked, which is the "definition yes, colour no"
  // case that must not be confused with "below the threshold".
  const withLevel = (row?.tokens ?? []).filter((t) => t.level !== null);
  check('at the first level, levelled words are marked', withLevel.length > 0, true);
  check('and every mark is at the list\'s first level', withLevel.every((t) => t.level === 1), true);
  check('the N5 word is recognised', row?.tokens?.find((t) => t.text === '勉強')?.defined, true);

  // The definition travels with the mark, so hover can explain it.
  sendFromPanel({ type: 'lookup', word: '日本語' });
  const reply = await waitForMessage(received, (m) => m.type === 'entry' && m.word === '日本語', 'the Japanese definition');
  check('its reading is kana, not pinyin', reply?.entry?.p, 'にほんご');
  check('and it has an English gloss', typeof reply?.entry?.m === 'string' && reply.entry.m.length > 0, true);
}

section('a level is shown by its own list\'s name, not its stored number');

{
  // The reported bug: 私, the simplest word in the language, JLPT N5, was shown
  // as "JLPT 1", which a viewer takes for N1, the HARDEST level. The stored level
  // is an ordering (1 = easiest); JLPT names its levels backwards from there, so
  // printing the number as a name inverts the meaning.
  const JAPANESE_VIDEO = {
    videoId: 'jaLevelName',
    title: 'Japanese Test',
    isLive: false,
    trackList: [{ languageCode: 'ja', name: 'Japanese', kind: null, isTranslatable: true }],
    translationLanguages: [{ languageCode: 'ja', name: 'Japanese' }],
  };

  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(JAPANESE_VIDEO),
    providePayload: {
      ok: true,
      video: JAPANESE_VIDEO,
      requested: 'ja',
      fetched: { languageCode: 'ja', segments: [{ start: 0, duration: 2, text: '私は学生です' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForState(received, (s) => Array.isArray(s.lists) && s.lists.length > 0, 'startup');
  await waitForState(received, (s) => s.learning?.listId !== null, 'a default list to be chosen');
  sendFromPanel({ type: 'set-list', listId: 'jlpt' });
  // Keep the state from this wait rather than reading the newest message later.
  // The lookup below adds an `entry` message, and `waitForState` only inspects
  // the most recent message, so asking for the threshold options afterwards
  // would never be satisfied and would time out, which reads as a code failure.
  const state = await waitForState(received, (s) => s.learning?.listId === 'jlpt', 'JLPT to be adopted');

  // The selector must read the same way as the badge, or the control and the
  // hover disagree about what level 1 is.
  check('the threshold options run N5 to N1', state?.learning?.thresholdOptions?.map((o) => o.label), ['N5', 'N4', 'N3', 'N2', 'N1']);
  // Easiest first, so choosing the top of the range marks the hardest words.
  check('with the stored numbers still ascending for the comparison', state?.learning?.thresholdOptions?.map((o) => o.value), [1, 2, 3, 4, 5]);

  // 私 is JLPT N5, stored level 1. The badge must say N5.
  sendFromPanel({ type: 'lookup', word: '私' });
  const reply = await waitForMessage(received, (m) => m.type === 'entry' && m.word === '私', 'the 私 definition');

  const jlpt = (reply?.levels ?? []).find((l) => l.id === 'jlpt');
  check('私 has a JLPT level at all', Boolean(jlpt), true);
  // The RELATIONSHIP, not the string: the level the list places it at must be the
  // level the list CALLS that position. Asserting 'N5' would pass even if the
  // names were reordered; this cannot.
  check('and it carries the list\'s name for that level', jlpt?.levelName, 'N5');
  check('not the stored number, which would read as N1', jlpt?.levelName !== String(jlpt?.level), true);
  // And the name has to agree with the selector, not merely be spelled right.
  check('which is the first option in the selector', state?.learning?.thresholdOptions?.[0]?.label, jlpt?.levelName);
}

section('a Japanese video offers only the Japanese list');

{
  // The list picker follows the video's language, so a choice that could only
  // fail is never presented. This asserts the picker rather than the coverage
  // message: with filtering there IS no "does not cover" state to reach, because
  // a Chinese list is never offered alongside Japanese text.
  //
  // The three variants are called out because they are different TRACKS that mean
  // the same thing, an auto-generated track has `kind: 'asr'`, and a machine
  // translation is the same track with a target language, and the filter must
  // treat all three as Japanese. It does so without naming any of them, because
  // the choice is made on the language CODE, which is shared.
  const variants = [
    ['plain Japanese', { languageCode: 'ja', name: 'Japanese', kind: null, isTranslatable: true }],
    ['auto-generated', { languageCode: 'ja', name: 'Japanese', kind: 'asr', isTranslatable: true }],
    ['Japan-ish region tag', { languageCode: 'ja-JP', name: 'Japanese (Japan)', kind: null, isTranslatable: true }],
  ];

  for (const [label, track] of variants) {
    const VIDEO_JA = {
      videoId: `ja-${label}`,
      title: 'Japanese Test',
      isLive: false,
      trackList: [track],
      translationLanguages: [{ languageCode: 'ja', name: 'Japanese' }],
    };

    const { received } = await boot({
      describePayload: DESCRIBE(VIDEO_JA),
      providePayload: {
        ok: true,
        video: VIDEO_JA,
        requested: track.languageCode,
        fetched: { languageCode: track.languageCode, segments: [{ start: 0, duration: 2, text: '日本語を勉強します' }] },
      },
      trackPayload: GERMAN,
    });

    const state = await waitForState(
      received,
      (s) => s.rows?.length > 0 && (s.learning?.listOptions ?? []).length === 1,
      `the list options to narrow for ${label}`,
    );

    check(`${label}: only the JLPT list is offered`, state.learning.listOptions.map((o) => o.value), ['jlpt']);
    check(`${label}: it is selected without the learner choosing it`, state.learning.listId, 'jlpt');
    // Never chosen for this list, so it begins at the first level of JLPT, not a
    // number carried from the Chinese list, whose numbering means something else.
    check(`${label}: the Japanese list starts at its own first level`, state.learning.threshold, 1);
  }
}

section('a Chinese video offers only the Chinese lists');

{
  // The other side of the same rule, and the one that proves the filter is not
  // just "always offer everything but sort differently".
  const { received } = await boot(TRACK(GERMAN));

  const state = await waitForState(
    received,
    (s) => s.rows?.length > 0 && (s.learning?.listOptions ?? []).length === 2,
    'the list options to narrow for Chinese',
  );

  check('the two HSK numberings are offered, and JLPT is not', state.learning.listOptions.map((o) => o.value), ['hsk2_0', 'hsk3_0']);
  check('the stored default is unchanged', state.learning.listId, 'hsk3_0');
  // Nothing has been chosen yet, so it starts at the first level. For HSK 3.0
  // that is level 1, which is what takes the patch above to a whole transcript
  // of marks, the point is that the NUMBER comes from the list, not that it is
  // any particular value.
  check('and its own threshold applies', state.learning.threshold, 1);
}

section('a word only the 3.0 list knows is marked once the learner sets a level');

{
  // This test no longer asserts anything about a DEFAULT. Marking starts at the
  // first level now, so every levelled word marks until the learner narrows it;
  // a test that depended on a particular default was really testing a policy
  // rather than the mechanism. It sets the threshold explicitly instead, which is
  // what makes it durable.
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'zh-Hans',
      fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: '啊哎' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  // 啊 is HSK 3.0 level 2 and 哎 is level 7, and 啊哎 is not a headword, so it
  // segments into the two characters. A threshold between them must mark exactly
  // the harder one, "surface the unknown", with the known half staying quiet.
  sendFromPanel({ type: 'set-threshold', threshold: 5 });
  await waitForState(received, (s) => s.learning?.threshold === 5, 'the threshold to apply');

  const state = received.at(-1)?.state;
  const row = state?.rows?.[0];
  const texts = row?.tokens?.map((t) => t.text) ?? [];
  check('the pair breaks into its characters', texts, ['啊', '哎']);

  const byText = Object.fromEntries((row?.tokens ?? []).map((t) => [t.text, t.level]));
  const threshold = state?.learning?.threshold;
  check('the below-threshold character stays unmarked', byText['啊'], null);
  check('the above-threshold character is marked', byText['哎'] > threshold, true);
  check('exactly one of the two is marked', row?.tokens?.filter((t) => t.level !== null).length, 1);
}

section('rows carry tokens, and only words at or beyond the threshold are marked');

{
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'zh-Hans',
      fetched: {
        languageCode: 'zh-Hans',
        // 我 is HSK 2.0 level 1, 们 is level 1, 岸上 is high. A threshold of 4
        // must leave the early characters unmarked.
        segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }],
      },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  // Set explicitly rather than relying on a default: the point under test is that
  // the threshold FILTERS, not what it happens to start at.
  sendFromPanel({ type: 'set-threshold', threshold: 4 });
  await waitForState(received, (s) => s.learning?.threshold === 4, 'the threshold to apply');

  const row = received.at(-1)?.state?.rows?.[0];
  check('the row has tokens', Array.isArray(row?.tokens), true);
  check('tokens reconstruct the line', row.tokens.map((t) => t.text).join(''), '我们在岸上等你');

  const marked = row.tokens.filter((t) => t.level !== null);
  const unmarked = row.tokens.filter((t) => t.level === null);
  check('some tokens are marked', marked.length > 0, true);
  check('and some are not, since they are below the threshold', unmarked.length > 0, true);

  // 我们 is HSK 2.0 level 1, so at threshold 4 it must stay unmarked. Note the
  // token is the whole word, not 我 and 们 separately, longest match prefers
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
      requested: 'zh-Hans',
      fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  // Start from a narrowed threshold, because marking now BEGINS at the first
  // level, so "lowering" from the default would test nothing.
  sendFromPanel({ type: 'set-threshold', threshold: 4 });
  await waitForState(received, (s) => s.learning?.threshold === 4, 'the narrow threshold to apply');
  const high = received.at(-1).state.rows[0].tokens.filter((t) => t.level !== null).length;

  sendFromPanel({ type: 'set-threshold', threshold: 1 });
  // A threshold change re-marks. Since `rebuildRows` now DISCARDS tokens built
  // under different settings, there is a real interval where the rows have no
  // tokens at all, so a predicate that only compares mark counts matches that
  // empty state and hands back rows with `tokens: undefined`. It has to require
  // tokens to be present AND to differ, which is what "re-marked" actually means.
  const lowState = await waitForState(
    received,
    (s) => {
      const tokens = s.rows?.[0]?.tokens;
      return Array.isArray(tokens) && tokens.filter((t) => t.level !== null).length !== high;
    },
    'the lower threshold to re-mark',
  );

  const low = lowState.rows[0].tokens.filter((t) => t.level !== null).length;
  check('a lower threshold marks at least as many', low >= high, true);
  check('and strictly more in this case', low > high, true);
  check('the threshold was reported back', received.at(-1).state.learning.threshold, 1);
}

// --- 3e. A realistically-shaped transcript -----------------------------------
//
// Every fixture above is three cues starting at zero. The real track is 403 cues
// starting at 37.9s with a 31-second silence in it, and the distance between those
// two things is where a session's worth of bugs lived.

section('a realistically-shaped transcript survives the round trip');

{
  const synthetic = fixture();
  const track = synthetic.tracks[0];
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: track.languageCode,
      fetched: { languageCode: track.languageCode, segments: track.segments },
    },
    trackPayload: { languageCode: track.languageCode, translateTo: null, segments: track.segments },
  });

  const state = await waitForState(stub.received, (s) => s.rows?.length > 1, 'the rows to arrive');

  check('every cue became a row', state.rows.length, track.segments.length);
  check('the first cue keeps its real offset', state.rows[0]?.start, track.segments[0].start);
  check('and it is not zero', state.rows[0].start > 0, true);
  check('the last row is the last cue', state.rows.at(-1)?.start, track.segments.at(-1).start);

  // A cue index is only meaningful against the transcript it was measured on, and
  // a long transcript is where an off-by-one or a stale index would actually show.
  const reported = stub.received.at(-1).state.activeIndex;
  check('the reported index is inside the transcript', reported === -1 || reported < state.rows.length, true);
}

section('the reported cue does not drift when the video is paused');

{
  // The Phase 4 finding. A previous browser run reported 403 cue times that were
  // ALL identical to the second with a 5s settle, and it was dismissed as flake.
  // It is not flake: a source-less video holds `currentTime` without advancing it,
  // so every poll legitimately reports the same cue.
  //
  // What matters is CONTAINMENT, not a frozen value. The exact second is not the
  // contract, the panel must not accumulate drift, which is what a rounding or
  // interpolation bug would look like over 403 cues.
  const synthetic = fixture();
  const track = synthetic.tracks[0];
  const stub = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: track.languageCode,
      fetched: { languageCode: track.languageCode, segments: track.segments },
    },
    trackPayload: { languageCode: track.languageCode, translateTo: null, segments: track.segments },
  });
  await waitForState(stub.received, (s) => s.rows?.length > 1, 'the rows to arrive');

  // Report a spread of positions across the track, the way playback would.
  const positions = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * (track.segments.at(-1).start - track.segments[0].start));
  const reported = [];
  for (const seconds of positions) {
    stub.listeners.message[0]({ target: 'background', type: 'content-position', index: 100, seconds }, { tab: { id: 1 } });
    await settle();
    reported.push(stub.received.at(-1)?.seconds);
  }

  // Every position came back as sent. A rounding bug over a 403-cue track shows up
  // here as a reported second that differs from the one asked for.
  const drift = reported.map((value, i) => Math.abs(value - positions[i]));
  check('the reported position is contained, not drifting', Math.max(...drift) < 0.05, true);
  check('and it is a spread, not one repeated value', new Set(reported).size, positions.length);
}

section('a word the list cannot place is still hoverable, just unmarked');

{
  // The reported bug: "the whole zhe yang le didn't get highlighted". 这样 and
  // 这么 have no HSK 2.0 level at all, they are HSK 3.0 level 2, so on HSK 2.0
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
      requested: 'zh-Hans',
      fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: '你这样说了吗' }] },
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
  // unmarked in both lists, a reminder that "no level" and "below threshold"
  // both render as unmarked and only the `defined` flag distinguishes them.)
  sendFromPanel({ type: 'set-list', listId: 'hsk3_0' });
  // Both conditions: the setting adopted AND the rows re-marked. A settings
  // change clears tokens before the new marking lands, so waiting on `listId`
  // alone returns the emptied rows and every assertion reads `undefined`.
  const back = await waitForState(
    received,
    (s) => s.learning?.listId === 'hsk3_0' && Array.isArray(s.rows?.[0]?.tokens),
    'the HSK 3.0 list to be re-adopted and re-marked',
  );

  const row3 = back.rows?.[0];
  const byText3 = Object.fromEntries((row3?.tokens ?? []).map((t) => [t.text, t]));

  check('这样 is definable in every list', byText3['这样']?.defined, true);

  // The threshold is set explicitly now rather than relied on. Marking starts at
  // the first level, so nothing is "below the threshold" until the learner places
  // it, this test is about WHERE the line falls, not about where it starts, so it
  // draws the line itself. 这样 is HSK 3.0 level 2.
  sendFromPanel({ type: 'set-threshold', threshold: 4 });
  const narrowed = await waitForState(
    received,
    (s) => s.learning?.threshold === 4 && Array.isArray(s.rows?.[0]?.tokens),
    'the raised threshold to re-mark',
  );
  const byText4 = Object.fromEntries((narrowed.rows?.[0]?.tokens ?? []).map((t) => [t.text, t]));

  check('and is below the threshold, so unmarked', byText4['这样']?.level, null);

  // Words below the threshold must stay hoverable too, not only words the list
  // omits entirely.
  check('a below-threshold word is still definable', byText4['你']?.defined, true);
  check('with no level shown', byText4['你']?.level, null);
}

section('the same word marks differently in the two lists');

{
  // 挨着 is HSK 3.0 level 6 and absent from HSK 2.0 entirely. At threshold 4 it
  // must be marked under 3.0 and unmarked under 2.0, while remaining hoverable
  // in both, which is the bug that was reported.
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'zh-Hans',
      fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: '他挨着我' }] },
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
      requested: 'zh-Hans',
      fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: '囍嚻' }] },
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
  // does not start at the live line. POSITION is an *event*, the content script
  // fires it once per cue change and dedupes, so a panel that opens afterwards
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

  // Now the panel goes away and the SAME worker is reopened, booting again
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
  // highlight an unrelated line, or run off the end.
  const stub = await boot(TRACK(GERMAN));
  await waitForFirstState(stub.received);

  stub.listeners.message[0](
    { target: 'background', type: 'content-position', index: 2, seconds: 60 },
    { tab: { id: 1 } },
  );
  await settle();
  // A cue report is a `position` message, not a `state` one, it carries `index`
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
    requested: 'zh-Hans',
    fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: 'Different' }] },
  });

  stub.sendFromPanel({ type: 'refresh' });
  await waitForState(stub.received, (s) => s.videoId === 'othervid001', 'the new video to be adopted');

  check('the new video starts with no cue', stub.received.at(-1)?.state?.activeIndex, -1);
}

section('switching language keeps the marks');

{
  // The other reported bug. Choosing a second subtitle track rebuilds the rows,
  // which discarded the tokens, and because the "already marked" flag was still
  // set, nothing re-attached them. The transcript came back unmarked until a
  // learning control was touched by hand, which changed the flag and forced it.
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'zh-Hans',
      fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
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
  // to survive that, the bug was that the rebuild discarded the tokens while
  // the "already marked" flag stayed set, so nothing re-attached them.
  sendFromPanel({ type: 'set-gloss', languageCode: 'de' });
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

section('a level chosen for one list is remembered, and never leaks into another');

{
  const { received, sendFromPanel } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'zh-Hans',
      fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
    },
    trackPayload: GERMAN,
  });
  await waitForMarks(received);

  // The learner narrows HSK 2.0 to its top level. This is the ONLY thing that
  // ever sets a starting level, the app does not guess one, and the data does
  // not carry one.
  sendFromPanel({ type: 'set-list', listId: 'hsk2_0' });
  await waitForState(received, (s) => s.learning?.listId === 'hsk2_0', 'HSK 2.0 to be adopted');
  sendFromPanel({ type: 'set-threshold', threshold: 6 });
  await waitForState(received, (s) => s.learning?.threshold === 6, 'the chosen level to apply');

  // HSK 3.0 has never been narrowed, so it starts fresh at its first level, the
  // number is NOT carried over, because 6 in a six-level list is not 6 in a
  // nine-level one.
  sendFromPanel({ type: 'set-list', listId: 'hsk3_0' });
  const fresh = await waitForState(
    received,
    (s) => s.learning?.listId === 'hsk3_0' && Array.isArray(s.rows?.[0]?.tokens),
    'HSK 3.0 to be adopted and re-marked',
  );
  check('an un-narrowed list starts at its first level', fresh.learning.threshold, 1);
  check('rows were rebuilt', Array.isArray(fresh.rows[0]?.tokens), true);

  // Back to HSK 2.0: the choice made there comes back, which is the whole point
  // of remembering per list rather than resetting.
  sendFromPanel({ type: 'set-list', listId: 'hsk2_0' });
  const returned = await waitForState(
    received,
    (s) => s.learning?.listId === 'hsk2_0' && s.learning?.threshold === 6,
    'HSK 2.0 to restore its remembered level',
  );
  check('returning to a list restores the level chosen for it', returned.learning.threshold, 6);
}

section('marks appear without the learner having to touch the controls');

{
  // The reported bug: subs render, but no highlighting until a dropdown is
  // changed by hand. Changing a control calls rebuildRows, so the symptom means
  // the marks were never applied on their own, the dictionary finished loading
  // and nothing re-marked the rows that were already on screen.
  const { received } = await boot({
    describePayload: DESCRIBE(VIDEO),
    providePayload: {
      ok: true,
      video: VIDEO,
      requested: 'zh-Hans',
      fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
    },
    trackPayload: GERMAN,
  });

  // Wait for the marks themselves, which is what this test is about, the bug
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
      requested: 'zh-Hans',
      fetched: { languageCode: 'zh-Hans', segments: [{ start: 0, duration: 2, text: '我们在岸上等你' }] },
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

section('a slow caption download is not timed out like a local question');

{
  // The bug this pins: every worker->content request shared one flat 4000ms
  // budget, so a PROVIDE that was downloading (and possibly translating) a
  // caption track was killed mid-flight on a slow video and reported as
  // "provide did not answer within 4000ms", a false failure that reads
  // exactly like a wedged content script.
  //
  // The worker exports nothing, so the budget is checked at the source, the
  // same way the licence and history guards work. What matters is the
  // RELATIONSHIP, not the numbers: the fetching path must outlast the local one.
  const source = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

  const local = Number(/const CONTENT_TIMEOUT_MS = (\d+)/.exec(source)?.[1]);
  const fetchMs = Number(/const CONTENT_FETCH_TIMEOUT_MS = (\d+)/.exec(source)?.[1]);

  check('a local question budget is defined', Number.isFinite(local), true);
  check('a fetching budget is defined', Number.isFinite(fetchMs), true);
  check('the fetching budget is the longer one', fetchMs > local, true);

  // The mapping has to name both fetching messages, or one of them silently
  // falls back to the short clock and the bug returns for just that path.
  const mapping = /function contentTimeoutFor\(message\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  check('PROVIDE takes the fetching budget', mapping.includes('MSG.PROVIDE'), true);
  check('FETCH_TRACK takes the fetching budget', mapping.includes('MSG.FETCH_TRACK'), true);

  // And the message the user actually sees now reports which clock ran out, so
  // a future report says "20000ms" and names the fetching path.
  check('the timeout names its own budget', source.includes('did not answer within ${timeoutMs}ms'), true);
}

section('the action menu is registered, because a missing item is invisible');

{
  // The bug this pins: the toolbar icon's menu is how a source is opened, and
  // when it is absent there is NOTHING to see, no error, no placeholder, just a
  // menu that does not list the item. It was shipped absent twice: first because
  // the `contextMenus` permission was missing entirely (the API does not exist
  // without it), and the design had claimed it cost no permission.
  //
  // So this asserts the registration reaches the browser, rather than trusting
  // that it does.
  const { calls } = await boot(TRACK(GERMAN));

  const readerItem = calls.menusCreated.find((item) => item.id === 'open-viewer');
  check('an item is created for the viewer', Boolean(readerItem), true);
  check('it has a title a user can read', typeof readerItem?.title, 'string');
  // `action` and NOT `page`: the item belongs on the toolbar icon's menu, so it
  // does not clutter the right-click menu of every web page the user visits.
  check('and it is on the action menu, not the page menu', readerItem?.contexts, ['action']);
}

{
  // A module-scope throw is fatal, and this registration happens at module scope
  // on purpose: an unpacked extension reloaded from chrome://extensions does not
  // reliably fire `onInstalled`, and a menu created only there is silently absent
  // on reload, which is exactly how it looked to the person testing it.
  const source = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const atTopLevel = /^ensureActionMenu\(\);/m.test(source);
  check('the menu is created at module scope, not only on install', atTopLevel, true);
  check('and the same call is repeated on install and update', /onInstalled[\s\S]{0,200}ensureActionMenu\(\)/.test(source), true);
}

section('a viewer tab is resolvable even when its announcement never arrives');

{
  // THE BUG THIS PINS. The viewer announces itself with `runtime.sendMessage`,
  // and `sender.tab` is not guaranteed for an extension PAGE (as opposed to a
  // content script). When it was absent the tab never registered, `isReadable`
  // said no, and the panel reported "no supported video is open in the active tab"
  // **while the film was playing in the next tab**, a failure that is both silent
  // and exactly backwards.
  //
  // So registration must not depend on the announcement. `runtime.getContexts` is
  // the authority: it lists the extension's own open contexts and each carries a
  // `tabId`, with no permission needed.
  const READER_TAB = { id: 7, active: true, url: '' }; // no url, as Chrome reports ours
  const { received } = await boot({
    tabs: [READER_TAB],
    // The viewer is open in tab 7, and NO VIEWER_READY message is sent, which is
    // the whole point.
    contexts: [
      { contextType: 'TAB', tabId: 7, documentUrl: 'chrome-extension://test/src/viewer/viewer.html' },
    ],
    describePayload: {
      ok: true,
      video: {
        videoId: 'local:film.mkv:100:1',
        title: 'film.mkv',
        isLive: false,
        trackList: [{ languageCode: 'zh', name: 'Chinese', isTranslatable: false }],
        translationLanguages: [],
      },
    },
    providePayload: {
      ok: true,
      requested: 'zh',
      fetched: {
        languageCode: 'zh',
        translateTo: null,
        segments: [{ start: 0, duration: 2, text: '你好世界' }],
      },
    },
    trackPayload: null,
  });

  // The panel asked for state on connect; it must resolve the viewer, not refuse.
  const state = received.find((m) => m.type === 'state')?.state;
  check('the viewer tab resolves without any announcement', Boolean(state), true);
  // The specific regression: this used to say no video was open.
  check('and it is NOT reported as no-video', String(state?.error ?? '').includes('CONN005'), false);
  // A viewer tab has no url, so if resolution worked it was via getContexts.
  check('it resolved despite having no tab url', READER_TAB.url, '');
  check('and its track list reached the panel', state?.trackList?.length, 1);
}

{
  // A DIFFERENT extension page in a tab must not be mistaken for a source. Only
  // our reader produces content, and treating another page as a source would
  // report an empty transcript for a page that is not a video at all.
  const { received } = await boot({
    tabs: [{ id: 9, active: true, url: '' }],
    contexts: [
      { contextType: 'TAB', tabId: 9, documentUrl: 'chrome-extension://test/src/sidepanel/sidepanel.html' },
    ],
  });

  const state = received.find((m) => m.type === 'state')?.state;
  check('another extension page is not treated as a source', String(state?.error ?? '').includes('CONN005'), true);
}

{
  // A context with `tabId: -1` is not in a tab and cannot be addressed. It must be
  // skipped rather than registered as tab -1, which would then never match a real
  // tab and would silently pollute the set.
  const { received } = await boot({
    tabs: [{ id: 3, active: true, url: '' }],
    contexts: [{ contextType: 'TAB', tabId: -1, documentUrl: 'chrome-extension://test/src/viewer/viewer.html' }],
  });

  const state = received.find((m) => m.type === 'state')?.state;
  check('a context with no tab is skipped', String(state?.error ?? '').includes('CONN005'), true);
}

// --- Settings: chrome.storage is the source of truth ------------------------

section('settings are stored, and never leave the machine');

{
  // The BUCKET is a decision this project already made and guards elsewhere:
  // `manifest.test.mjs` fails the build if anything touches `storage.sync`, because
  // that would put preferences in the user's Google account. So this asserts the
  // positive half, a setting is genuinely persisted, and leaves the "not sync"
  // half to the guard that owns it.
  //
  // Asserted here rather than assumed because the storage path moved: the worker
  // used to write `storage.local` directly and now goes through `settingsStore()`,
  // and a typo in that indirection would silently drop every setting on the floor
  // while the panel carried on working from its in-memory copy until reload.
  const stub = await boot();
  stub.sendFromPanel({ type: 'set-setting', target: 'background', id: 'romaji', value: 'below' });
  await settle();

  check('the setting was persisted', stub.storage.settings?.romaji, 'below');
}

section('a change made elsewhere is not lost by a live worker');

{
  // **This is the whole point of the change.** The worker used to read settings
  // once at boot and keep them, so a write made by another surface, the viewer,
  // a settings page, another window, never reached it. It kept serving the value
  // it started with, and the panel showed a setting the user had already changed.
  //
  // The storage area's own cross-context event is what fixes that, and it is also
  // the mechanism that keeps working while this worker is asleep.
  const stub = await boot();
  const before = stub.received.filter((m) => m.type === 'state').length;

  // Another context writes to the bucket directly, as the viewer would.
  await stub.chromeStorage.local.set({
    settings: { ...stub.storage.settings, romaji: 'below' },
  });
  await settle();

  const states = stub.received.filter((m) => m.type === 'state');
  check('the worker broadcast a new state', states.length > before, true);

  // The value has to be in the state the WORKER derives, not merely in storage.
  // Reading it back from storage would pass even if the worker ignored the event.
  const latest = states.at(-1)?.state;
  check('and the state carries the new value', latest?.learning?.romaji, 'below');
}

section('a change that affects the rows rebuilds them');

{
  // Storing the new value is not enough. The reading placement is applied when
  // the rows are BUILT, so a worker that stored `below` and did not rebuild would
  // push a state whose rows still carried the old annotation, the setting would
  // look like it did nothing, which is exactly the bug the local write path
  // guards against. The external path needs the same guard.
  const stub = await boot(TRACK(CHINESE));
  await waitForMarks(stub.received);

  await stub.chromeStorage.local.set({
    settings: { ...stub.storage.settings, romaji: 'above' },
  });
  await settle();
  const marked = await waitForMarks(stub.received);

  check('the rows were rebuilt after the external write', Array.isArray(marked.rows[0]?.tokens), true);
  check('and the setting is in force', marked.learning?.romaji, 'above');
}

section('a presentation-only change does not rebuild');

{
  // `view` and `fontSize` are applied by the panel and change no row's content, so
  // rebuilding them in the worker is wasted work. Distinguishing the two is what
  // keeps this listener cheap: it fires on EVERY settings write from any context,
  // including ones that cannot affect the transcript at all.
  const stub = await boot(TRACK(CHINESE));
  await waitForMarks(stub.received);

  const statesBefore = stub.received.filter((m) => m.type === 'state').length;
  await stub.chromeStorage.local.set({
    settings: { ...stub.storage.settings, fontSize: 22, view: 'focus' },
  });
  await settle();

  // A state is still pushed, the panel needs the new value, but the rows are
  // carried over rather than re-marked, which is the observable difference.
  const states = stub.received.filter((m) => m.type === 'state');
  check('a state is still pushed', states.length > statesBefore, true);
  check('and the new value is in it', states.at(-1)?.state?.learning?.fontSize, 22);
}

section('the worker does not re-broadcast its own write');

{
  // A write this worker made echoes back on the change event. Treating that echo
  // as news would rebuild twice for every change and broadcast twice, which
  // would show up as a stutter on every control, not as a wrong value, so a
  // value assertion would not catch it.
  const stub = await boot(TRACK(CHINESE));
  await waitForMarks(stub.received);

  stub.sendFromPanel({ type: 'set-setting', target: 'background', id: 'romaji', value: 'off' });
  await settle();
  const after = stub.received.filter((m) => m.type === 'state').length;
  await settle();

  check('the count does not grow again on the echo', stub.received.filter((m) => m.type === 'state').length, after);
}

// --- Result -----------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
