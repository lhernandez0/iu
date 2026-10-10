/**
 * Boots the YouTube content script with stubs and drives it through its message
 * surface.
 *
 * The content script is the one place that turns YouTube's response into
 * segments. If the parser is wrong it returns an empty list, and the panel
 * reports "this video has no captions", a wrong answer that looks like a
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

/** Swap the global warning sink so tests can read what the script logged. */
let warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));

// --- Stubs -------------------------------------------------------------------

/**
 * A DOMParser good enough for the shapes YouTube emits.
 *
 * Entities ARE decoded here, matching the real parser. The real English track
 * carries 161 `&amp;` sequences, an earlier version of this stub left them raw on
 * the grounds that entity handling was not what was being tested, which was true
 * right up until a real capture showed escaping is a routine part of the body. A
 * stub that is laxer than the platform turns every escaping bug into a passing
 * test.
 */
const decodeEntities = (text) =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

class StubDomParser {
  /** @param {string} text @param {string} mime */
  parseFromString(text, mime) {
    if (mime !== 'text/xml') throw new Error(`unexpected mime ${mime}`);

    const nodes = [...text.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((match) => {
      const attributes = new Map();
      for (const attr of match[1].matchAll(/(\w+)="([^"]*)"/g)) attributes.set(attr[1], attr[2]);
      return {
        getAttribute: (name) => attributes.get(name) ?? null,
        // Nested markup is flattened, as `textContent` does, so a body carrying a
        // child element yields its text and not its tags.
        textContent: decodeEntities(match[2].replace(/<[^>]*>/g, '')),
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
  // and the process does not stay alive on a real timer. `active` tracks which
  // are still running, so stopping them can be observed, that is how the
  // orphaned-context teardown is tested.
  define('setInterval', (fn) => {
    const handle = intervals.length + 1;
    intervals.push({ handle, fn, active: true });
    return handle;
  });
  define('clearInterval', (handle) => {
    const entry = intervals.find((i) => i.handle === handle);
    if (entry) entry.active = false;
  });
  define('setTimeout', globalThis.setTimeout);

  define('chrome', {
    runtime: {
      // Present on a live context and absent once the extension is reloaded,
      // which is what the script reads to notice it has been orphaned. A stub
      // without it looks dead, and the script correctly stops talking, so this
      // has to be here for anything to be reported at all.
      id: 'test-extension-id',
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
        // A real `sendResponse` is a callback into the extension, so calling it
        // after a reload throws rather than quietly resolving. Modelling that is
        // what makes the "context died mid-request" path reachable.
        const sendResponse = (payload) => {
          if (!globalThis.chrome.runtime.id) throw new Error('Extension context invalidated.');
          resolve(payload);
        };
        onMessage({ ...message, target: 'content' }, {}, sendResponse);
      });
    },
    /** Advance the simulated video and fire the position poll. */
    tick(seconds) {
      video.currentTime = seconds;
      for (const entry of intervals) if (entry.active) entry.fn();
    },
    /**
     * Simulate the extension being reloaded out from under this script.
     *
     * Chrome strips the id from an orphaned context; every call into it then
     * throws. The throw is part of the simulation, a stub that quietly returned
     * undefined would not exercise the same path.
     */
    orphan() {
      Object.defineProperty(globalThis.chrome.runtime, 'id', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      globalThis.chrome.runtime.sendMessage = () => {
        throw new Error('Extension context invalidated.');
      };
    },
    posted,
    fetched,
    video,
    intervalCount: () => intervals.length,
    runningIntervals: () => intervals.filter((i) => i.active).length,
  };
}

/** @param {string} name @param {any} value */
function define(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

// --- Fixtures ----------------------------------------------------------------
//
// Two kinds, and the distinction matters.
//
// SUMMARY / JSON3 / XML below are small inputs crafted to exercise PARSER LOGIC,
// whitespace-only cues being dropped, multi-part `segs` being joined, milliseconds
// becoming seconds. They are not a claim about YouTube's shape, and their values
// are arbitrary on purpose.
//
// The committed corpus in `test/synthetic/` is the other half: our own invented
// text wearing shapes measured from a real capture. That is where a claim about
// YouTube's shape is allowed to live, because it traces to something real.
//
// Everything in this file used to be the first kind while pretending to be the
// second, which is why thirteen bugs were reported from use and none were found
// here.

import { fixture, json3From, xmlFrom, summaryFrom } from './synthetic/load.mjs';
import { readFileSync } from 'node:fs';

const SYNTHETIC = fixture();

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

/**
 * The real refusal body, copied verbatim from a capture.
 *
 * Google answers a caption request it does not want to serve with an HTTP **200**
 * and this HTML page, so nothing about the status says failure. Trimmed to the
 * significant parts, it is a 1103-byte document and the middle is inline CSS, but
 * the title, the opening tag and the head are exactly as received, because those
 * are what the detection keys on.
 *
 * Kept as a literal rather than read from `test/fixtures/`, which is gitignored and
 * therefore absent on a fresh clone. A test that skipped without it would stop
 * covering the case that mattered most.
 */
const BLOCK_PAGE = `<!doctype html><html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"/>
<title>Sorry...</title><style> body { font-family: verdana, arial, sans-serif; background-color: #fff; color: #000; }</style></head><body><div><table><tr><td><b><font face=sans-serif size=10><font color=#4285f4>G</font><font color=#ea4335>o</font><font color=#fbbc05>o</font><font color=#4285f4>g</font><font color=#34a853>l</font><font color=#ea4335>e</font></font></b><p>Your computer or network may be sending automated queries. To protect our users, we can't process your request right now.</p></div></body></html>`;

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

// --- 3b. The real-shaped corpus ----------------------------------------------
//
// Everything above uses small crafted inputs to check PARSER LOGIC. These use the
// committed corpus, invented text in shapes measured from a real capture, to
// check the pipeline survives a REALISTIC one.
//
// This is the gap that mattered. Every fixture was tiny and started at zero, so
// nothing here had ever parsed a track that starts at 37.9s, contains a 31-second
// silence, or runs to 403 cues. A session's worth of bugs lived in exactly that
// distance between the fixtures and the real thing.

section('parses a realistically-shaped track (403 cues, real timings)');

{
  const track = SYNTHETIC.tracks[0];
  const script = await bootContent({ summary: summaryFrom(SYNTHETIC), captionBody: json3From(track.segments) });
  const result = await script.ask({ type: 'fetch-track', languageCode: track.languageCode });

  check('every cue parsed', result?.segments?.length, track.segments.length);
  check('more than a handful, so scale is exercised', result.segments.length > 100, true);
  // The real track does not start at zero, and code that assumes it does is wrong.
  check('the offset is preserved, not normalised to zero', result?.segments?.[0]?.start, track.segments[0].start);
  check('and it is not zero', result.segments[0].start > 0, true);
  // Real timings carry milliseconds; rounding them away would drift a long track.
  check('sub-second precision survives', result?.segments?.[0]?.duration, track.segments[0].duration);
  check('text came through intact', result?.segments?.[0]?.text, track.segments[0].text);

  // Multi-part `segs` are joined. The corpus splits them on some cues because the
  // real body does, and a parser reading only `segs[0]` would lose half a line.
  const splitIndex = track.segments.findIndex((_, i) => i % 3 === 1 && track.segments[i].text.length > 1);
  check('a split cue is rejoined', result.segments[splitIndex]?.text, track.segments[splitIndex].text);

  // The gap is the reason `paused` exists at all. It has to be present in the
  // fixture or the hold-the-last-line path is never reached.
  const gaps = result.segments
    .slice(1)
    .map((s, i) => s.start - (result.segments[i].start + result.segments[i].duration));
  check('the long silence is present', Math.max(...gaps) > 20, true);
}

section('the same cues parse identically from JSON3 and from XML');

{
  const track = SYNTHETIC.tracks[0];
  const summary = summaryFrom(SYNTHETIC);

  const viaJson = await bootContent({ summary, captionBody: json3From(track.segments) }).then((script) =>
    script.ask({ type: 'fetch-track', languageCode: track.languageCode }),
  );
  const viaXml = await bootContent({ summary, captionBody: xmlFrom(track.segments) }).then((script) =>
    script.ask({ type: 'fetch-track', languageCode: track.languageCode }),
  );

  // Two serialisations of one track must produce one transcript. This is the check
  // the XML branch never had against a realistic body, it had only ever seen two
  // hand-written cues in a fixture written to match my own parser.
  check('the same number of cues', viaXml.segments.length, viaJson.segments.length);
  check('with the same timings', viaXml.segments[0].start, viaJson.segments[0].start);
  check('and the same text', viaXml.segments[0].text, viaJson.segments[0].text);
  check('and the same last cue', viaXml.segments.at(-1).text, viaJson.segments.at(-1).text);
}

section('escaping survives the XML body, because the real one carries 161 entities');

{
  // The real English XML track escapes genuine ampersands. If the two paths
  // disagreed on the cue that contains one, the transcript would show `&amp;`
  // whenever a track arrived as XML, a bug no hand-written fixture would ever
  // have produced, because the fixtures did not contain an ampersand.
  const track = SYNTHETIC.tracks.find((t) => t.languageCode === 'en') ?? SYNTHETIC.tracks[0];
  const summary = summaryFrom(SYNTHETIC);

  // A cue that must be escaped on the way out and decoded on the way in.
  const escaped = { start: 1, duration: 1, text: 'Salt & pepper, and a 5 < 10 deal' };
  const cues = [escaped, ...track.segments.slice(0, 3)];
  const xml = xmlFrom(cues);

  check('the body escapes the ampersand', xml.includes('&amp;'), true);
  check('and escapes the less-than', xml.includes('&lt;'), true);

  const viaJson = await bootContent({ summary, captionBody: json3From(cues) }).then((script) =>
    script.ask({ type: 'fetch-track', languageCode: track.languageCode }),
  );
  const viaXml = await bootContent({ summary, captionBody: xml }).then((script) =>
    script.ask({ type: 'fetch-track', languageCode: track.languageCode }),
  );

  check('the XML path decoded the entity', viaXml.segments[0].text, escaped.text);
  check('and matches the JSON3 path exactly', viaXml.segments[0].text, viaJson.segments[0].text);
  check('with no raw entity left behind', /&amp;|&lt;/.test(viaXml.segments[0].text), false);
}

section('describe reports the real track vocabulary, not an invented pair');

{
  const script = await bootContent({ summary: summaryFrom(SYNTHETIC), captionBody: '{}' });
  const video = (await script.ask({ type: 'describe' }))?.video;

  // The codes and names come from the capture. `zh-Hans` rather than `zh` is the
  // kind of detail a hand-written fixture gets wrong without anyone noticing.
  check('the real language codes', video?.trackList?.map((t) => t.languageCode), SYNTHETIC.tracks.map((t) => t.languageCode));
  check('and the real names', video?.trackList?.map((t) => t.name), SYNTHETIC.tracks.map((t) => t.name));
  // 156 in the capture. Asserting the count would break on a different video, so
  // this asserts the relationship: a real list is large, and has region-tagged
  // codes in it.
  check('a full translation-language list, not two entries', video?.translationLanguages?.length > 50, true);
  check('including a region-tagged code', video.translationLanguages.some((l) => l.languageCode.includes('-')), true);
  check(
    'and every code has a name',
    video.translationLanguages.every((l) => typeof l.name === 'string' && l.name.length > 0),
    true,
  );
}

// --- 4. Empty and malformed --------------------------------------------------

section('an empty or useless response is reported, not silently accepted');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: '' });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });
  check('empty body yields no segments', result?.segments?.length, 0);
  check('and says so', result?.error, 'TRACK002 The caption track came back empty.');
}

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON.stringify({ events: [] }) });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });
  check('no events yields no segments', result?.segments?.length, 0);
  check('and says so', result?.error, 'TRACK002 The caption track came back empty.');
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
  check('and an explanation', result?.error, 'TRACK002 The caption track came back empty.');
}

section('a refusal is reported as a refusal, not as an empty track');

{
  // The body is the REAL one, taken from a capture: Google's "Sorry..." block
  // page, which arrives as HTTP 200 with an HTML body. It is kept verbatim rather
  // than paraphrased, because the whole bug was that its shape was not recognised
  //, a hand-written stand-in would encode my idea of the page instead of the page.
  //
  // What used to happen: no `<text>` elements, so it parsed to zero cues, so the
  // failure was reported as "the caption track came back empty". That says the
  // VIDEO has no captions, which is a fact about the video. The truth was that the
  // server had stopped answering, which is temporary and clears on its own. Those
  // need opposite responses from a reader, wait, versus give up, and one message
  // for both sent a whole session the wrong way.
  //
  // The block page is 1103 bytes, so `body.trim()` is truthy: this is not the
  // empty-body path, and nothing but the shape can catch it.
  const script = await bootContent({
    summary: SUMMARY,
    captionBody: BLOCK_PAGE,
    innertubeBody: JSON.stringify({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fresh=1', languageCode: 'en', name: { simpleText: 'English' } },
          ],
        },
      },
    }),
  });

  const result = await script.ask({ type: 'fetch-track', languageCode: 'en' });

  check('no segments', result?.segments?.length, 0);
  check('and the error names a refusal', result?.error, 'TRACK005 The caption request was refused, likely too many requests.');
  check('not an empty track', (result?.error ?? '').startsWith('TRACK002'), false);
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
  check('a clear message', result?.error, 'VIDEO001 This video has no captions.');
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
  // `ja`, where it would collide with a real Japanese track on the same video,
  // and the two would silently overwrite each other.
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'en', translateTo: 'ja' });

  check('languageCode is the source', result?.languageCode, 'en');
  check('the target is reported apart from it', result?.translateTo, 'ja');
}

section('translating a track that cannot be translated is refused, not faked');

{
  // `de` is marked isTranslatable: false. Asking anyway returns the UNTRANSLATED
  // German, which would be silently presented as Japanese, a wrong answer that
  // looks like a right one, which is the failure mode worth guarding.
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  const result = await script.ask({ type: 'fetch-track', languageCode: 'de', translateTo: 'ja' });

  check('no segments are returned', result?.segments?.length, 0);
  check('the error explains why', result?.error, 'TRACK001 This caption track cannot be auto-translated.');
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

section('a transcript handed over is what position reporting measures against');

{
  // The worker skips the fetch entirely for a cached video, so the content
  // script never gets segments, and it reports position BY looking at them. A
  // freshly loaded page therefore reported no cue at all, which is why the panel
  // neither highlighted nor scrolled until the next cue change.
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });

  // Nothing loaded yet: no position is reported, because there is nothing to
  // measure against.
  script.tick(0.5);
  check('nothing reported before a transcript is handed over', script.posted.length, 0);

  const handedOver = await script.ask({
    type: 'set-track',
    // The video id travels with the segments; without it the next sync() reads
    // the hand-over as a new video and clears it.
    videoId: 'dQw4w9WgXcQ',
    segments: [
      { start: 0, duration: 1, text: 'First' },
      { start: 5, duration: 1, text: 'Second' },
    ],
  });
  check('the hand-over is acknowledged', handedOver?.ok, true);

  // The very next tick must report. Suppressing the first one, the usual dedupe
  // shape, would leave a paused video silent forever.
  script.tick(0.5);
  check('a cue is reported straight away', script.posted.at(-1)?.index, 0);
  check('and it is being spoken', script.posted.at(-1)?.paused, false);

  script.tick(3.0);
  check('the gap is reported as paused', script.posted.at(-1)?.paused, true);
  check('still holding the finished line', script.posted.at(-1)?.index, 0);
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
  check('and it is being spoken', script.posted.at(-1)?.paused, false);

  script.tick(0.9); // still cue 0
  check('nothing reported for the same cue', script.posted.length, 1);

  script.tick(2.0); // inside cue 1
  check('reported entering cue 1', script.posted.at(-1)?.index, 1);
  check('and it is a background-targeted position', script.posted.at(-1)?.type, 'content-position');
}

section('a gap between cues holds the last line, and says it is not speaking');

{
  // The reported bug: nothing showed between lines in Live view, and nothing
  // was highlighted in Full view. The index alone cannot express this, because
  // "the line that finished" and "the line being said" are the same index, so
  // the gap has to be reported separately.
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  await script.ask({ type: 'provide' });
  script.posted.length = 0;

  // Cue 0 runs 0-1.54s and cue 1 starts at 1.54s, so 1.5 is the boundary and
  // there is no gap here. Cue 1 runs 1.54-5.7s, and cue 2 starts at 5.7s.
  script.tick(1.0);
  check('inside cue 0 it is speaking', script.posted.at(-1)?.paused, false);

  // Past the end of the last cue is the one case that is genuinely over.
  script.tick(7.0);
  const last = script.posted.at(-1);
  // The final cue's span is where playback sits, so it still holds it.
  check('past the last cue the index is held', last?.index, 1);
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

// --- 8. An orphaned extension context ----------------------------------------
//
// When the extension is reloaded or updated, content scripts already running in
// open tabs are orphaned. `chrome.runtime` is still an object but has lost its
// id, and every call into it throws "Extension context invalidated." Both polling
// loops keep waking, so the result was not one error but one every 250ms until
// the tab was reloaded, and nothing could silence it.

section('a live context reports position as usual');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  await script.ask({ type: 'provide', languageCode: 'en' });

  script.tick(0.5);
  check('a position was reported', script.posted.some((p) => p.type === 'content-position'), true);
  check('the intervals are running', script.runningIntervals(), 2);
}

section('once orphaned, it stops instead of throwing every tick');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  await script.ask({ type: 'provide', languageCode: 'en' });

  const quiet = [];
  const realError = console.error;
  console.error = (...args) => quiet.push(args.join(' '));

  script.orphan();
  // This is the reported failure: the interval wakes, posts, and throws.
  let thrown = null;
  warnings = [];
  try {
    script.tick(0.5);
  } catch (error) {
    thrown = error;
  }

  check('nothing was thrown', thrown, null);
  check('both intervals stopped', script.runningIntervals(), 0);
  // Case-insensitive on purpose: the assertion is about the message existing,
  // not about its capitalisation. A case-sensitive match here failed against a
  // correct warning and looked like the fix was broken.
  check('and it said so once', warnings.filter((w) => /reload this tab/i.test(w)).length, 1);

  // The important part: it does not keep trying. A second wake must be silent,
  // not another error and another warning.
  warnings = [];
  try {
    script.tick(1.5);
  } catch (error) {
    thrown = error;
  }
  check('a further tick throws nothing', thrown, null);
  check('and says nothing more', warnings.length, 0);

  console.error = realError;
}

section('a dead context is not posted to at all');

{
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  await script.ask({ type: 'provide', languageCode: 'en' });
  const before = script.posted.length;

  script.orphan();
  script.tick(0.5);

  check('no further messages were sent', script.posted.length, before);
}

section('a reply to a request that outlived the context does not throw');

{
  // Every branch answers asynchronously, so the extension can be reloaded while
  // a caption fetch is in flight, and `sendResponse` then throws from inside a
  // promise, where nothing is listening for it.
  //
  // The reply never arrives, which is faithful: the worker's own timeout is what
  // covers that. What matters is that the throw does not escape and that the
  // script stops rather than continuing to poll.
  const script = await bootContent({ summary: SUMMARY, captionBody: JSON3 });
  script.orphan();

  let thrown = null;
  warnings = [];
  try {
    // Deliberately not awaited, it cannot settle.
    void script.ask({ type: 'fetch-track', languageCode: 'en' }).catch(() => {});
    await settle();
    await settle();
  } catch (error) {
    thrown = error;
  }

  check('nothing was thrown', thrown, null);
  check('and it stopped cleanly', script.runningIntervals(), 0);
}

// --- Every fetch is bounded --------------------------------------------------

section('no request in the content script can hang the reply');

{
  // The bug this pins: `fetch` has no default timeout, so a caption request that
  // STALLS rather than being refused never resolves. `provide()` then never
  // returns, the reply is never sent, and Chrome reports "the message channel
  // closed before a response was received", a sentence that names the channel
  // and not the cause. The request has to reach a deadline so the reply is sent.
  const source = readFileSync(new URL('../src/content/youtube-content.js', import.meta.url), 'utf8');

  // Exactly one raw fetch, the one inside the wrapper. Any second one is a
  // request that can hang the reply, which is the whole failure being fixed.
  const rawFetch = source.match(/(?<![\w.])fetch\(/g) ?? [];
  check('exactly one raw fetch call exists', rawFetch.length, 1);

  check('the wrapper is defined', source.includes('function fetchBounded('), true);
  check('the wrapper attaches a deadline', source.includes('AbortSignal.timeout('), true);
  check(
    'and a sane budget is used',
    /const CAPTION_FETCH_TIMEOUT_MS = (\d+)/.exec(source)?.[1],
    '12000',
  );

  // The wrapper must be what the fetch paths call, not a definition nobody uses.
  const boundedCalls = source.match(/fetchBounded\(/g) ?? [];
  check('the fetch paths go through the wrapper', boundedCalls.length >= 4, true);
}

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
