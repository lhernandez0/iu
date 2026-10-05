/**
 * Boots the YouTube content script with stubs and drives it through its message
 * surface.
 *
 * The content script is the one place that turns YouTube's response into
 * segments. If the parser is wrong it returns an empty list, and the panel
 * reports "this video has no captions" — a wrong answer that looks like a
 * legitimate one. That is worth a test.
 *
 * It is a classic IIFE with no exports, so it cannot be imported for its
 * functions. Instead it is evaluated for real and driven the way the worker
 * drives it: a message in, a response out. That exercises the actual code path,
 * including the page-bridge handshake.
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

// --- Stubs -------------------------------------------------------------------

/**
 * A DOMParser good enough for the shapes YouTube emits. Entity handling is
 * deliberately absent: the real parser decodes `&#39;`, this only needs to prove
 * the attributes and text are read correctly.
 */
class StubDomParser {
  /** @param {string} text @param {string} mime */
  parseFromString(text, mime) {
    if (mime !== 'text/xml') throw new Error(`unexpected mime ${mime}`);

    const nodes = [...text.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((match) => {
      const attributes = new Map();
      for (const attr of match[1].matchAll(/(\w+)="([^"]*)"/g)) attributes.set(attr[1], attr[2]);
      return {
        getAttribute: (name) => attributes.get(name) ?? null,
        textContent: match[2],
      };
    });

    return {
      querySelector: (selector) => (selector === 'parsererror' && /<parsererror/.test(text) ? {} : null),
      querySelectorAll: (selector) => (selector === 'text' ? nodes : []),
    };
  }
}

/**
 * Install globals and evaluate a fresh copy of the content script.
 *
 * @param {object} options
 * @param {object} options.summary            What the page bridge reports.
 * @param {string} [options.captionBody]      Body returned for a caption track.
 * @param {number} [options.captionFailures]  How many caption fetches to fail
 *   first, so the INNERTUBE fallback can be reached deliberately.
 * @param {string} [options.innertubeBody]    Body for the internal player API.
 * @param {boolean} [options.innertubeOk]     Whether that endpoint responds.
 * @returns {Promise<object>} Handles for driving the script.
 */
async function bootContent({
  summary,
  captionBody = '',
  captionFailures = 0,
  innertubeBody = '{}',
  innertubeOk = true,
}) {
  const posted = [];
  const intervals = [];
  const fetched = [];
  let captionFetches = 0;
  /** @type {((message: object, sender: object, respond: Function) => any) | null} */
  let onMessage = null;

  /** A response shape with both readers, since the script uses each. */
  const respond = (ok, body) => ({
    ok,
    text: async () => body,
    json: async () => JSON.parse(body),
  });

  // The content script keeps its own state in these.
  const contentWindow = {
    location: { origin: 'https://www.youtube.com' },
    addEventListener: (type, handler) => {
      if (type === 'message') contentWindow._messageListeners.push(handler);
    },
    removeEventListener: () => {},
    _messageListeners: [],
    // Stands in for the MAIN-world bridge: whatever the content script asks
    // for, answer immediately with the configured summary.
    postMessage: (data) => {
      const reply = {
        channel: data.channel,
        direction: 'response',
        requestId: data.requestId,
        ok: true,
        payload: summary,
      };
      for (const handler of contentWindow._messageListeners) {
        handler({ source: contentWindow, origin: contentWindow.location.origin, data: reply });
      }
    },
  };

  const video = { currentTime: 0, paused: false };
  const documentStub = {
    querySelector: (selector) => (selector === 'video' ? video : null),
  };

  define('window', contentWindow);
  define('document', documentStub);
  define('DOMParser', StubDomParser);
  define('fetch', async (url) => {
    const href = String(url);
    fetched.push(href);

    // Distinguish the two endpoints: the fallback re-asks the internal player
    // API, and treating both alike would make the fallback untestable.
    if (href.includes('/youtubei/v1/player')) {
      return respond(innertubeOk, innertubeBody);
    }

    captionFetches++;
    if (captionFetches <= captionFailures) return respond(false, '');
    return respond(true, captionBody);
  });
  // Captured rather than scheduled, so a test can step playback deterministically
  // and the process does not stay alive on a real timer.
  define('setInterval', (fn) => {
    intervals.push(fn);
    return intervals.length;
  });
  define('setTimeout', globalThis.setTimeout);

  define('chrome', {
    runtime: {
      onMessage: {
        addListener: (handler) => {
          onMessage = handler;
        },
      },
      sendMessage: async (payload) => {
        posted.push(payload);
        return { ok: true };
      },
    },
  });

  await import(`../src/content/youtube-content.js?boot=${++bootCount}`);
  await settle();

  return {
    /** Send a message the way the worker does, and await the reply. */
    ask(message) {
      return new Promise((resolve) => {
        if (!onMessage) throw new Error('content script never registered onMessage');
        onMessage({ ...message, target: 'content' }, {}, resolve);
      });
    },
    /** Advance the simulated video and fire the position poll. */
    tick(seconds) {
      video.currentTime = seconds;
      for (const fn of intervals) fn();
    },
    posted,
    fetched,
    video,
    intervalCount: () => intervals.length,
  };
}

/** @param {string} name @param {any} value */
function define(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

// --- Fixtures ----------------------------------------------------------------

const SUMMARY = {
  videoId: 'dQw4w9WgXcQ',
  title: 'Test Video',
  isLive: false,
  tracks: [
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en', languageCode: 'en', name: 'English', kind: null, isTranslatable: true },
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=de', languageCode: 'de', name: 'Deutsch', kind: null, isTranslatable: false },
  ],
  translationLanguages: [
    { languageCode: 'en', name: 'English' },
    { languageCode: 'ja', name: 'Japanese' },
  ],
  innertubeApiKey: 'KEY',
};

const JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1540, segs: [{ utf8: 'Hey there' }] },
    { tStartMs: 1540, dDurationMs: 4160, segs: [{ utf8: 'how are' }, { utf8: ' you' }] },
    { tStartMs: 5700, dDurationMs: 1000, segs: [{ utf8: '\n' }] }, // whitespace only
  ],
});

const XML = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="0" dur="1.54">Some text</text>
  <text start="1.54" dur="4.16">Some additional text</text>
</transcript>`;

// --- 1. It evaluates ---------------------------------------------------------

section('content script evaluates');

{
  let error = null;
  try {
    await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  } catch (thrown) {
    error = thrown;
  }
  check('module evaluates', error, null);
}

// --- 2. JSON3 parsing --------------------------------------------------------

section('parses the JSON3 response YouTube returns for fmt=json3');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });

  check('no error', result?.error, null);
  check('two real cues, whitespace-only dropped', result?.segments?.length, 2);
  check('first text', result?.segments?.[0]?.text, 'Hey there');
  check('milliseconds became seconds', result?.segments?.[0]?.start, 0);
  check('duration converted too', result?.segments?.[0]?.duration, 1.54);
  check('multi-part segments are joined', result?.segments?.[1]?.text, 'how are you');
  check('later cue offset', result?.segments?.[1]?.start, 1.54);
}

// --- 3. XML parsing ----------------------------------------------------------

section('parses the XML response, which is what arrives when JSON3 is unsupported');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: XML });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });

  check('no error', result?.error, null);
  check('two cues', result?.segments?.length, 2);
  check('text read', result?.segments?.[0]?.text, 'Some text');
  check('start read', result?.segments?.[0]?.start, 0);
  check('duration read', result?.segments?.[0]?.duration, 1.54);
  check('second cue', result?.segments?.[1]?.text, 'Some additional text');
}

// --- 4. Empty and malformed --------------------------------------------------

section('an empty or useless response is reported, not silently accepted');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: '' });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });
  check('empty body yields no segments', result?.segments?.length, 0);
  check('and says so', result?.error, 'The caption track came back empty.');
}

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON.stringify({ events: [] }) });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });
  check('no events yields no segments', result?.segments?.length, 0);
  check('and says so', result?.error, 'The caption track came back empty.');
}

{
  const script = await bootContent({ summary: SUMMARY, captionBody: '{ not json' });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });
  check('malformed json does not crash', Array.isArray(result?.segments), true);
  check('and reports empty', result?.segments?.length, 0);
}

// --- 5. The INNERTUBE fallback ----------------------------------------------

section('when the direct track fetch is refused, it re-asks the internal player API');

{
  // This is the path jdepoix/youtube-transcript-api documents as necessary for
  // server-side callers. It is adopted here only as a fallback, and until now
  // could not be exercised at all.
  const innertubeBody = JSON.stringify({
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fresh=1',
            languageCode: 'en',
            name: { simpleText: 'English' },
          },
        ],
      },
    },
  });

  const script = await bootContent({
    summary: SUMMARY,
    captionBody: JSON3,
    captionFailures: 1, // the first, direct fetch is refused
    innertubeBody,
  });

  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });

  check('the internal player API was consulted', script.fetched.some((u) => u.includes('/youtubei/v1/player')), true);
  check('and the track came back anyway', result?.segments?.length, 2);
  check('with the right text', result?.segments?.[0]?.text, 'Hey there');
  check('no error reported', result?.error, null);
}

section('if the internal player API also fails, the failure is reported');

{
  const script = await bootContent({
    summary: SUMMARY,
    captionBody: JSON3,
    captionFailures: 1,
    innertubeOk: false,
  });

  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });
  check('no segments', result?.segments?.length, 0);
  check('and an explanation', result?.error, 'The caption track came back empty.');
}

// --- 6. Track selection ------------------------------------------------------

section('fetch-track answers for the requested language');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'de' });
  check('reports the language it fetched', result?.languageCode, 'de');
}

section('an unknown language falls back to the first available track');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'zz' });
  check('falls back', result?.languageCode, 'en');
}

section('a video with no caption tracks says so plainly');

{
  const script = await bootContent({ summary: { ...SUMMARY, tracks: [] }, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });
  check('no segments', result?.segments?.length, 0);
  check('a clear message', result?.error, 'This video has no captions.');
}

// --- 5b. Auto-translate ------------------------------------------------------
//
// YouTube's "auto-translate" is not a separate track. It is the SAME track's
// baseUrl with `&tlang=` added, which is why the cue timings are identical and
// why this composes with alignment and seeking for free. These tests pin that
// mechanism, since nothing else in the pipeline can: the worker only ever sees
// the resulting text.

section('a translation is requested by adding tlang to the track URL');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en', translateTo: 'ja' });

  check('no error', result?.error, null);
  check('segments came back', result?.segments?.length, 2);

  const url = script.fetched.find((u) => u.includes('timedtext'));
  check('the track URL was used', Boolean(url), true);
  check('tlang was appended', url?.includes('tlang=ja'), true);
  check('and the requested track was kept', url?.includes('lang=en'), true);
  // fmt is set alongside, so the translation is still parsed as JSON3 rather
  // than falling back to XML.
  check('the format is still pinned', url?.includes('fmt=json3'), true);
}

section('without a translation the URL is left alone');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  await script.ask({ type: 'fetch-track', languageCode: 'en' });

  const url = script.fetched.find((u) => u.includes('timedtext'));
  check('no tlang parameter', url?.includes('tlang'), false);
  check('but the format is still pinned', url?.includes('fmt=json3'), true);
}

section('the reported language is the SOURCE, with the target reported separately');

{
  // The worker keys its cache and its rows by the source track. Reporting the
  // TARGET as the language would file an English-to-Japanese translation under
  // `ja`, where it would collide with a real Japanese track on the same video —
  // and the two would silently overwrite each other.
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en', translateTo: 'ja' });

  check('languageCode is the source', result?.languageCode, 'en');
  check('the target is reported apart from it', result?.translateTo, 'ja');
}

section('translating a track that cannot be translated is refused, not faked');

{
  // `de` is marked isTranslatable: false. Asking anyway returns the UNTRANSLATED
  // German, which would be silently presented as Japanese — a wrong answer that
  // looks like a right one, which is the failure mode worth guarding.
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'de', translateTo: 'ja' });

  check('no segments are returned', result?.segments?.length, 0);
  check('the error explains why', result?.error, 'This caption track cannot be auto-translated.');
  check('and no tlang request was made', script.fetched.some((u) => u.includes('tlang')), false);
  check('the source language is still reported', result?.languageCode, 'de');
}

section('a translation into the source language is still just a fetch');

{
  // Not special-cased in the content script; the panel filters it out of the
  // menu so this cannot be chosen. Asserted so the behaviour is pinned.
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en', translateTo: 'en' });
  check('it fetches normally', result?.segments?.length, 2);
  check('with the parameter set', script.fetched.some((u) => u.includes('tlang=en')), true);
}

section('describe reports the translation languages for this video');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'describe' });

  check('they are reported', result?.video?.translationLanguages?.length, 2);
  check('with their codes', result?.video?.translationLanguages?.map((l) => l.languageCode), ['en', 'ja']);
  // isTranslatable has to reach the worker, which uses it to decide whether a
  // stored translation preference is worth acting on for this video.
  check('and tracks carry translatability', result?.video?.trackList?.map((t) => t.isTranslatable), [true, false]);
}

// --- 6. Seek -----------------------------------------------------------------

section('seek moves the page video');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const reply = await script.ask({ type: 'content-seek', seconds: 12.5 });

  check('reports success', reply?.ok, true);
  check('the video element moved', script.video.currentTime, 12.5);
}

// --- 7. Position reporting ---------------------------------------------------

section('position is reported only when the active cue changes');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  await script.ask({ type: 'provide' });
  script.posted.length = 0;

  script.tick(0.5); // inside cue 0
  check('reported entering cue 0', script.posted.at(-1)?.index, 0);

  script.tick(0.9); // still cue 0
  check('nothing reported for the same cue', script.posted.length, 1);

  script.tick(2.0); // inside cue 1
  check('reported entering cue 1', script.posted.at(-1)?.index, 1);
  check('and it is a background-targeted position', script.posted.at(-1)?.type, 'content-position');
}

section('nothing is reported before a transcript is loaded');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  script.posted.length = 0;
  script.tick(2);
  check('no position reports', script.posted.length, 0);
}

// --- 8. Re-entry guard -------------------------------------------------------

section('re-evaluating does not stack up duplicate interval timers');

{
  // The worker injects this file on every request, so a second evaluation must
  // be a no-op. Without the guard each injection would add another reporter and
  // every position would be sent twice.
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const before = script.intervalCount();
  await import(`../src/content/youtube-content.js?again=${Date.now()}`);
  check('no extra interval registered', script.intervalCount(), before);
}

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
