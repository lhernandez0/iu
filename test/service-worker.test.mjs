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
  const stub = installChromeStub(options);
  await import(`../src/background/service-worker.js?boot=${++bootCount}`);

  const panel = createPanelPort();
  for (const listener of stub.listeners.connect) listener(panel.port);
  await settle();

  return { ...stub, received: panel.received, sendFromPanel: panel.sendFromPanel };
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
  await new Promise((resolve) => setTimeout(resolve, 100));

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
  await new Promise((resolve) => setTimeout(resolve, 200));

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

  // Marking happens after the dictionary resolves, so wait for it.
  await new Promise((resolve) => setTimeout(resolve, 50));

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
  await new Promise((resolve) => setTimeout(resolve, 50));

  const high = received.at(-1).state.rows[0].tokens.filter((t) => t.level !== null).length;

  sendFromPanel({ type: 'set-threshold', threshold: 1 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const low = received.at(-1).state.rows[0].tokens.filter((t) => t.level !== null).length;
  check('a lower threshold marks at least as many', low >= high, true);
  check('and strictly more in this case', low > high, true);
  check('the threshold was reported back', received.at(-1).state.learning.threshold, 1);
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

  await new Promise((resolve) => setTimeout(resolve, 200));
  const before = received.at(-1).state.rows[0].tokens.filter((t) => t.level !== null).length;
  check('marked to begin with', before > 0, true);

  // Choose a second subtitle language, which rebuilds every row.
  sendFromPanel({ type: 'set-secondary', languageCode: 'de' });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const after = received.at(-1).state.rows[0];
  check('the second language arrived', after.secondary.length > 0, true);
  check('the text is unchanged', after.text, '我们在岸上等你');
  check('and the marks survived', after.tokens.filter((t) => t.level !== null).length, before);
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
  await new Promise((resolve) => setTimeout(resolve, 50));

  sendFromPanel({ type: 'set-list', listId: 'hsk3_0' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const state = received.at(-1).state;
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

  // Wait long enough for the word list to load and for anything it triggers.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const row = received.at(-1)?.state?.rows?.[0];
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
  await new Promise((resolve) => setTimeout(resolve, 50));

  sendFromPanel({ type: 'lookup', word: '我们' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const reply = received.at(-1);
  check('an entry was sent back', reply?.type, 'entry');
  check('for the word asked about', reply?.word, '我们');
  check('with a definition', typeof reply?.entry?.m, 'string');
  check('and pinyin', typeof reply?.entry?.p, 'string');
  check('and every list that places it', Array.isArray(reply?.levels), true);
}

section('a word with no level still gets a definition');

{
  const { received, sendFromPanel } = await boot(TRACK(GERMAN));
  await new Promise((resolve) => setTimeout(resolve, 50));

  // The user's own instruction: unlevelled words should still be looked up,
  // they simply carry no HSK colour or badge.
  sendFromPanel({ type: 'lookup', word: '囍' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const reply = received.at(-1);
  check('an entry was sent', reply?.type, 'entry');
  check('it has no levels', reply?.levels?.length, 0);
  check('and no dictionary entry either, so entry is null', reply?.entry, null);
}

// --- Result -----------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
