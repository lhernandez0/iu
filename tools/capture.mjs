/**
 * Capture a real YouTube video into fixtures.
 *
 *   npm run capture                      # capture what .env lists
 *   npm run capture -- --check           # preflight, opens NOTHING
 *   npm run capture -- --replay          # rehearse offline, opens NOTHING
 *   npm run capture -- --list            # show the plan, opens NOTHING
 *   npm run capture -- --force           # re-capture over an existing fixture
 *
 * THE ONLY THING IN THIS PROJECT THAT OPENS youtube.com.
 *
 * That is the rule this tool exists to enforce, and the reason it is shaped the
 * way it is. Every test — hermetic, replay, anything added later — reads captured
 * fixtures and never touches the network, so hitting the real site is a thing you
 * do deliberately, once, and can never happen as a side effect of running a
 * suite.
 *
 * Because the run is meant to happen ONCE, three of the four modes above open
 * nothing at all. `--check` proves the preconditions, `--replay` runs the whole
 * pipeline against an existing capture with the network stubbed, and `--list`
 * shows what would happen. Only a bare invocation opens a page, it refuses to run
 * unless preflight passes, and it refuses to clobber an existing fixture without
 * `--force`.
 *
 * That shape exists because of a real failure: this tool was iterated against the
 * live site on its first outing — four page loads of the same video — because
 * there was no way to rehearse it and no cost to running it again. Every one of
 * those four could have been caught offline. A network call you only get once has
 * to be treated like one.
 *
 * ---------------------------------------------------------------------------
 *
 * What it records, for one video, in one page load:
 *
 *   test/fixtures/<id>/raw/          exactly what YouTube sent
 *   test/fixtures/<id>/normalised/   the same, cleaned up and readable
 *
 * Both, on purpose. The raw bytes are the honest record — nothing about our
 * beliefs is in them, so they can falsify a wrong assumption rather than confirm
 * it. The normalised copies are what a person actually reads while reviewing,
 * because a fixture you cannot read is a fixture nobody checks.
 *
 * The capture is deliberately EXHAUSTIVE about body SHAPES, because the single
 * open has to answer every format question we have:
 *
 *   - the direct caption URL, with and without `fmt=json3`
 *   - the internal player API's URL, with and without `fmt=json3`
 *   - the same track translated with `tlang`
 *   - the page's own player response, AND a fresh one from the ANDROID client
 *     the extension's fallback actually uses
 *
 * Two of those are known to matter from the first capture: the direct URL answers
 * 200 with an EMPTY body on a real video, so only the fallback had content — and
 * our XML parser had never once seen a real XML body, because `fmt=json3` had
 * always been forced. The second capture resolved the second half: the ANDROID
 * client's default format returns `text/xml`, so a real default-format body is now
 * held and the parser has run against it.
 *
 * Fixtures are LOCAL and gitignored: a raw capture contains a signed caption URL
 * (`signature`, `ei`, `ip`, `expire`), which is a session artifact rather than
 * something to put in a repository. The committed counterpart is
 * `test/synthetic/` — our own invented content, shaped by a structural report
 * derived from a real capture. That is what the tests read.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rename, rm, readdir, cp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test', 'fixtures');
const STAGING = join(FIXTURES, '.staging');

/** How long to let the real page boot its own scripts before reading it. */
const PAGE_SETTLE_MS = 5000;

/**
 * How long one caption request may take before it is abandoned.
 *
 * A capture is a single page load, so a request that never answers does not just
 * lose its own body — it holds the run open until the browser gives up, and the
 * bodies still to come are lost with it. Bounding each request means the worst
 * case is one missing body rather than a spent capture.
 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * The most caption requests one run may make, across every video it is given.
 *
 * A hard ceiling rather than a hope. The endpoint is free and we are not its
 * customer, so the tool does not get to spend an unbounded number of requests
 * because a video happens to have many tracks. The plan is now shaped to sit well
 * under this (about seven for the format matrix plus one per language), so hitting
 * it means something is wrong rather than that a video is large.
 *
 * The previous version made 57 requests for one 9-track video. That is not a
 * budget this tool had, and earning a rate limit from it is what made every video
 * look like it had no captions for hours afterwards.
 */
const MAX_REQUESTS = 12;

/**
 * How many EXTRA tracks get a content request of their own.
 *
 * The parsing path does not vary by language — the first track proves it — so the
 * only thing more languages buy is a different script and encoding. Two extra is
 * enough for that, and it does not grow with the video: a nine-track video costs
 * the same as a three-track one.
 */
const MAX_TRACK_CONTENT = 2;

/**
 * Whether a response is the server refusing us rather than answering.
 *
 * 429 is explicit. The other two are how a silent refusal actually arrives: a 200
 * whose body is an HTML page — Google's "Sorry..." block page is 1103 bytes of
 * HTML with a 200 status. Treating that as a caption body is what let a rate limit
 * masquerade as "this video has no captions", because a parser finds no `<text>`
 * elements in an error page and reports an empty track.
 *
 * `shape` is already computed per response, and an HTML error page is neither
 * `json3` nor `xml`, so the shape test catches it without re-inspecting the body.
 *
 * @param {{status: number, shape: string|null, body: string}} result
 * @returns {boolean}
 */
function isRefusal(result) {
  if (result.status === 429) return true;
  if (result.status === 403) return true;
  // A body that is not a caption document, on a response that claimed success.
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(result.body ?? '');
  return looksLikeHtml || (result.ok && result.shape === 'other');
}

/**
 * Classify a body by what it IS, not by what we asked for.
 *
 * A response is the ground truth about its own format; the request that produced
 * it is only a hope. Classifying by the request would let a server that ignores
 * `fmt` (answering XML to a `fmt=json3` call, or JSON to no-`fmt` at all) be
 * recorded as whatever we wanted, and the disagreement — which is the interesting
 * part — would be invisible.
 *
 * @param {string} body
 * @returns {'json3'|'xml'|'empty'|'other'}
 */
function bodyShape(body) {
  const text = body.trim();
  if (!text) return 'empty';
  if (text.startsWith('{') || text.startsWith('[')) return 'json3';
  if (text.startsWith('<')) return 'xml';
  return 'other';
}

/**
 * Does the body look like the resource we asked for?
 *
 * The question the recorded `shape` exists to answer, kept as a function so the
 * rehearsal can assert it across every entry rather than leaving a reader to spot
 * a mismatch.
 *
 * `ttml` is served as XML, so an XML body satisfies a `ttml` request. Anything
 * else — including an HTML error page, which is neither — is a mismatch.
 *
 * @param {string|undefined} shape Observed body shape.
 * @param {string|null} fmt What the request asked for.
 * @returns {boolean}
 */
function formatMatches(shape, fmt) {
  const wanted = fmt === 'json3' ? 'json3' : 'xml';
  return shape === wanted;
}

/**
 * Reject if a promise has not settled within `ms`.
 *
 * Playwright's own timeout is generous, and a caption request that hangs does not
 * fail — it just never returns, holding the single page load open. This bounds the
 * cost of a hang to one body instead of the whole capture.
 *
 * The underlying request is not cancelled (it cannot be, from here); it is
 * abandoned, which is enough because every later step works from the body we hold.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Read `.env` from the project root, if there is one.
 *
 * Hand-rolled rather than a dependency: the subset we need is a dozen lines, and
 * it has to work before anything is installed. A parser would be more code than
 * the thing it parses.
 *
 * Values already present in the real environment win, so
 * `IU_CAPTURE_VIDEOS=x npm run capture` overrides the file the way it looks like
 * it should.
 */
function loadEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (key in process.env) continue;
    // Quotes are the documented way to keep a `#` inside a value, so strip a
    // matched pair rather than treating everything after it as a comment.
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
}

/**
 * Video ids from a whitespace- or comma-separated list.
 *
 * Accepts full URLs as well as bare ids, because a URL is what a person has in
 * hand — they paste the address bar. A bare id in a config file reads like a
 * typo; a URL does not.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseVideoIds(raw) {
  return (
    String(raw ?? '')
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => {
        // `new URL` needs a scheme, and people paste `youtu.be/x` and
        // `youtube.com/watch?v=x` without one, so try both readings.
        let url = null;
        for (const candidate of [token, `https://${token}`]) {
          try {
            url = new URL(candidate);
            break;
          } catch {
            /* try the next reading */
          }
        }
        if (!url) return token;

        return (
          // Path forms first: `/shorts/<id>` and `/live/<id>` are unambiguous,
          // whereas a `v` parameter can be unrelated — a shorts URL with `?v=1`
          // on it would otherwise resolve to the literal id "1".
          /^\/(?:shorts|live)\/([\w-]+)/.exec(url.pathname)?.[1] ??
          // youtu.be/<id> — the short form, which is what the Share button hands
          // out, so it is the URL most likely to be pasted.
          (/^youtu\.be$/i.test(url.hostname) ? url.pathname.slice(1).split('/')[0] : null) ??
          url.searchParams.get('v') ??
          token
        );
      })
      // A hostless path such as `/shorts/x` is not a video reference at all;
      // anything still containing a slash after all that is not an id.
      .filter((id) => id && !id.includes('/'))
  );
}

/**
 * Query parameters that are session artifacts rather than part of the format.
 *
 * They are useless as credentials — `expire` is hours away at most — but they
 * are still someone's session, they make every re-capture look like a total
 * change, and there is no reason for them to be in a fixture. Dropped from the
 * URLs we record; the raw BODIES keep everything, because those are the record.
 */
const VOLATILE_PARAMS = [
  'signature', 'ei', 'ip', 'ipbits', 'expire', 'exp', 'sparams', 'pot', 'potc',
  'c', 'cver', 'cplatform', 'cbr', 'cbrver', 'cos', 'cosver', 'cplayer', 'hl',
  'xorb', 'xobt', 'xovt', 'xoaf', 'xowf', 'clen', 'dur', 'lsparams', 'lsig', 'n',
];

/**
 * @param {string} url
 * @returns {string} The URL with session-scoped parameters removed.
 */
function scrubUrl(url) {
  try {
    const parsed = new URL(url);
    for (const param of VOLATILE_PARAMS) parsed.searchParams.delete(param);
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url;
  }
}

/** @param {string} name */
function section(name) {
  console.log(`\n${name}`);
}

// --- Shape reporting ---------------------------------------------------------

/**
 * A structural summary of a value: keys and types, never content.
 *
 * This is the licence-safe bridge from a real capture to the committed synthetic
 * corpus. It records what a reviewer needs to confirm our invented fixtures have
 * the same SHAPE as YouTube's — which fields exist, what type each is, how an
 * array nests — while containing none of the video's text. Facts about a format,
 * not about a film.
 *
 * Arrays are summarised from their first element, plus their length, because the
 * question being asked is "what does one of these look like" and the count of
 * cues is content rather than shape. An empty array reports as such, which is
 * itself a finding.
 *
 * @param {any} value
 * @param {number} [depth]
 * @returns {any}
 */
function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth > 4) return '[…]';
    return value.length ? { __array: value.length, item: shapeOf(value[0], depth + 1) } : { __array: 0 };
  }
  const type = typeof value;
  if (type === 'string') return 'string';
  if (type === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (type === 'boolean') return 'boolean';
  if (type !== 'object') return type;

  if (depth > 4) return '{…}';
  const out = {};
  for (const key of Object.keys(value)) out[key] = shapeOf(value[key], depth + 1);
  return out;
}

/**
 * The fields the extension actually reads, pulled out of a parsed body.
 *
 * Narrower than `shapeOf` on purpose: a full player response is enormous and its
 * shape includes hundreds of fields we will never touch. What matters is the
 * handful the extension depends on, so the report says "here is what we read and
 * here is what it looked like", which is directly reviewable.
 *
 * @param {object} body Parsed player response.
 * @returns {object}
 */
function rendererReport(body) {
  const renderer = body?.captions?.playerCaptionsTracklistRenderer;
  if (!renderer) return { present: false };

  return {
    present: true,
    rendererKeys: Object.keys(renderer).sort(),
    trackCount: (renderer.captionTracks ?? []).length,
    trackShape: shapeOf(renderer.captionTracks?.[0] ?? null),
    translationLanguageCount: (renderer.translationLanguages ?? []).length,
    translationLanguageShape: shapeOf(renderer.translationLanguages?.[0] ?? null),
    // Recorded because it is the field most likely to differ between clients, and
    // the extension's fallback depends entirely on the ANDROID client's track list.
    defaultAudioTrackIndex: renderer.defaultAudioTrackIndex ?? null,
  };
}

// --- Collection --------------------------------------------------------------

/**
 * Every body shape worth having, as requests to make inside the one page load.
 *
 * WHY THIS IS NO LONGER PER-TRACK. The first version built the whole matrix for
 * every caption track — 4 combinations plus two explicit formats plus a
 * translation, times every track. On a real 9-track video that is 57 requests in
 * one run, which is not a budget this tool gets to spend: it is a free endpoint we
 * are not paying for, and 57 rapid requests in a row is indistinguishable from
 * abuse. It earned a rate limit, and the rate limit then looked like "every video
 * has no captions" for hours.
 *
 * The matrix answers questions about a FORMAT and a CLIENT — what shape does the
 * endpoint return, does it honour `fmt`, do the two clients disagree. Those
 * answers do not vary by language, so asking them once answers them for the whole
 * video. What is genuinely per-track is the CONTENT, and that needs one request
 * per language, not seven.
 *
 * ORDER MATTERS and is deliberate. The one shape we do not hold is a real
 * default-format body — everything captured so far was requested with `fmt=json3`
 * — so that is collected FIRST, before anything else can fail and take the shot
 * with it. The page client comes before the fallback for the same reason: it is the
 * path the extension tries first, so it is the one worth having.
 *
 * `client` is which player response supplies the URL. They can disagree, and the
 * extension uses both.
 *
 * @param {object[]} tracks
 * @param {string|null} translateTo
 * @returns {Array<{name: string, track: object, client: 'page'|'android', fmt: string|null, tlang: string|null}>}
 */
function collectionPlan(tracks, translateTo) {
  if (!tracks.length) return [];

  // The track that gets the format/client matrix. Deliberately the FIRST of the
  // VIDEO'S OWN languages rather than an auto-generated one: a manual track is the
  // case a learner actually studies from, and `kind` is the only signal available
  // here for telling them apart.
  const subject = tracks.find((t) => t.kind !== 'asr') ?? tracks[0];

  const plan = [];
  const add = (fields) => plan.push(fields);
  /** Tracks already given a content request, so each language costs at most one. */
  const content = [];

  // --- The shape probe: one track, every format and client --------------------
  for (const fmt of [null, 'json3']) {
    for (const client of ['page', 'android']) {
      add({
        name: `${client} client, ${fmt ?? 'default format'}`,
        track: subject,
        client,
        fmt,
        tlang: null,
      });
    }
  }

  // Explicit alternative format names. They cost one request each and are the only
  // remaining way to reach the XML branch of a parser that has otherwise only ever
  // seen bodies we built ourselves.
  for (const fmt of ['srv3', 'ttml']) {
    add({ name: `page client, explicit ${fmt}`, track: subject, client: 'page', fmt, tlang: null });
  }

  // One translation, on the same track, to learn the shape. The target is recorded
  // so it is reproducible.
  if (translateTo && subject.isTranslatable) {
    add({
      name: `translated to ${translateTo}`,
      track: subject,
      client: 'android',
      fmt: 'json3',
      tlang: translateTo,
    });
  }

  // --- Content for a few languages, because content is per-language -----------
  //
  // Bounded on purpose. The extension's parsing does not vary by language, so the
  // first track already proves the path; what more languages add is DIFFERENT
  // SCRIPTS — a CJK body and a Latin one exercise encoding and cue shapes that a
  // single track does not. Three is enough for that and it does not grow with the
  // video: a 9-track video does not get 9 content requests, it gets three.
  for (const track of tracks) {
    if (content.length >= MAX_TRACK_CONTENT) break;
    if (track.languageCode === subject.languageCode) continue;
    if (content.some((t) => t.languageCode === track.languageCode)) continue;
    content.push(track);
    add({
      name: `${track.languageCode}, default format`,
      track,
      client: 'page',
      fmt: null,
      tlang: null,
    });
  }

  return plan;
}

/** @param {object} request */
function describeRequest(request) {
  return {
    languageCode: request.track.languageCode,
    client: request.client,
    fmt: request.fmt,
    tlang: request.tlang,
    description: request.name,
  };
}

/** @param {object} request @returns {string} */
function requestLabel(request) {
  const parts = ['captions', request.track.languageCode, request.client, request.fmt ?? 'default'];
  if (request.tlang) parts.push(`tlang-${request.tlang}`);
  return parts.join('-');
}

/** @param {string} text @returns {string} */
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The two rehearsal-only cues, and what each must decode to.
 *
 * Kept as data so the rehearsal can CHECK them rather than just print them. An
 * absence of warnings is not evidence; these are the exact strings a correct
 * parser must produce.
 *
 * `REHEARSAL_ENTITY` is written with an encoded ampersand on purpose, so reading
 * it back proves entity decoding actually ran. `REHEARSAL_MARKUP` wraps a word in
 * a child element, so reading it back proves `textContent` flattens markup instead
 * of leaking tags into the transcript.
 */
const REHEARSAL_ENTITY = 'rehearsal cue with an escaped &amp; ampersand';
const REHEARSAL_MARKUP = 'rehearsal cue with a <i>child element</i> inside';
const REHEARSAL_EXPECTED = [
  'rehearsal cue with an escaped & ampersand',
  'rehearsal cue with a child element inside',
];

/**
 * Rebuild a JSON3 body in the XML shape YouTube sends when nobody asks for a
 * format.
 *
 * REHEARSAL ONLY — this never runs against the network and never writes a fixture.
 * It was originally the only way `--replay` could exercise the XML branch, because
 * no capture held a default-format body. One now does, so the rehearsal serves the
 * real one and this is a FALLBACK for a capture that predates it (or for `--check`,
 * which needs a sample and has no capture to read). Recognising when it is being
 * used matters: a rehearsal that claimed to test the real body while actually
 * testing this would be the exact self-deception this whole exercise is about.
 *
 * The cues are the real ones from the capture — real timings, real text — just in
 * the other serialisation. Two extra cues are appended that the real body does
 * not contain, because they exercise code the real one cannot reach:
 *
 *   - an escaped `&amp;`, which proves entity decoding
 *   - a child element `<i>`, which proves `textContent` flattens markup rather
 *     than leaking tags into the transcript
 *
 * Those two are marked in the XML as rehearsal-only so nobody later mistakes them
 * for something YouTube sent.
 *
 * @param {string} json3Text
 * @returns {string}
 */
function xmlFromJson3(json3Text) {
  let events = [];
  try {
    events = JSON.parse(json3Text)?.events ?? [];
  } catch {
    return '';
  }

  const cues = events
    .filter((event) => Array.isArray(event.segs))
    .map((event) => {
      const text = event.segs
        .map((seg) => seg.utf8 ?? '')
        .join('')
        .replace(/\n/g, ' ')
        .trim();
      if (!text) return null;
      const start = (event.tStartMs ?? 0) / 1000;
      const dur = (event.dDurationMs ?? 0) / 1000;
      return `  <text start="${start}" dur="${dur}">${escapeXml(text)}</text>`;
    })
    .filter(Boolean);

  return [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<transcript>',
    ...cues,
    '  <!-- rehearsal-only, not from YouTube: entity decoding + child flattening -->',
    `  <text start="0" dur="0.1">${REHEARSAL_ENTITY}</text>`,
    `  <text start="0" dur="0.1">${REHEARSAL_MARKUP}</text>`,
    '</transcript>',
  ].join('\n');
}

// --- Entry modes -------------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('-')));
const MODE_CHECK = flags.has('--check');
const MODE_REPLAY = flags.has('--replay');
const MODE_LIST = flags.has('--list');
const FORCE = flags.has('--force');

/**
 * `--fail-after=N` — rehearse the FAILURE path, not just the happy one.
 *
 * The capture that cost the shot failed part-way through the collection loop, and
 * the code that decides what to keep on failure had never once been executed. A
 * rehearsal that only proves the success path is rehearsing the wrong thing. This
 * makes the loop throw after N requests, so the partial-promotion path runs for
 * real.
 *
 * Ignored outside `--replay`; a real run must never be sabotaged.
 */
const failAfterArg = args.find((a) => a.startsWith('--fail-after='));
const FAIL_AFTER = failAfterArg ? Number.parseInt(failAfterArg.split('=')[1], 10) : null;
if (failAfterArg && !(Number.isInteger(FAIL_AFTER) && FAIL_AFTER >= 0)) {
  console.error(`--fail-after needs a whole number of requests, got "${failAfterArg}".
`);
  process.exit(2);
}

loadEnv();

const explicit = args.filter((a) => !a.startsWith('-'));
const videoIds = explicit.length
  ? explicit.map((id) => parseVideoIds(id)[0] ?? id)
  : parseVideoIds(process.env.IU_CAPTURE_VIDEOS);

/** Show the plan without opening anything. */
if (MODE_LIST || !videoIds.length) {
  section(MODE_LIST && videoIds.length ? `Would capture ${videoIds.length} video(s) — nothing was opened` : 'Nothing configured');
  for (const videoId of videoIds) {
    const done = existsSync(join(FIXTURES, videoId, 'normalised', 'video.json'));
    console.log(`  ${videoId}${done ? '   (already captured)' : ''}`);
  }
  if (!videoIds.length) {
    console.log('');
    console.log('Set them in .env (copy .env.example first):');
    console.log('');
    console.log('    IU_CAPTURE_VIDEOS=https://www.youtube.com/watch?v=…');
    console.log('');
    console.log('Or name one directly:  npm run capture -- <videoId|url>');
  }
  console.log('');
  console.log('THIS IS THE ONLY COMMAND IN THE PROJECT THAT OPENS youtube.com.');
  process.exit(videoIds.length ? 0 : 1);
}

const executablePath = findChrome();

/**
 * Everything that must be true before a page is opened.
 *
 * Checked rather than assumed, because each of these has already cost a wasted
 * open: a missing browser, an unusable id, a fixture we are about to overwrite.
 *
 * @returns {string[]} Problems, empty when good.
 */
function preflight() {
  const problems = [];
  if (!executablePath) problems.push('No Chromium able to load extensions. Set CHROME_PATH.');
  if (!videoIds.length) problems.push('No video ids resolved from .env or the command line.');

  for (const videoId of videoIds) {
    if (!/^[\w-]{6,}$/.test(videoId)) problems.push(`"${videoId}" does not look like a video id.`);
    if (!FORCE && !MODE_REPLAY && existsSync(join(FIXTURES, videoId, 'normalised', 'video.json'))) {
      problems.push(`${videoId} is already captured. Use --force to replace it, or --replay to rehearse.`);
    }
  }

  // A rehearsal needs something to rehearse against.
  if (MODE_REPLAY && !videoIds.some((id) => existsSync(join(FIXTURES, id)))) {
    problems.push('--replay needs an existing capture to replay, and found none.');
  }

  return problems;
}

if (MODE_CHECK || MODE_REPLAY) {
  const problems = preflight();
  section(MODE_CHECK ? 'Preflight — opens nothing' : 'Replay rehearsal — opens nothing');
  console.log(`  browser:   ${executablePath ?? 'NOT FOUND'}`);
  console.log(`  video(s):  ${videoIds.join(', ') || 'none'}`);
  console.log(`  mode:      ${MODE_REPLAY ? 'replay (network stubbed)' : 'check only'}`);
  for (const videoId of videoIds) {
    const captured = existsSync(join(FIXTURES, videoId, 'normalised', 'video.json'));
    console.log(`  ${videoId}: ${captured ? 'already captured' : 'not captured'}`);
  }
  console.log('');
  if (problems.length) {
    for (const problem of problems) console.log(`  !! ${problem}`);
    console.log('\n  Refusing to continue.');
    process.exit(1);
  }
  console.log('  all preconditions satisfied');

  if (MODE_CHECK) {
    // Parse a sample body on a blank page, exactly as the real run will.
    //
    // This is what `--check` is FOR. Every other precondition is a file or a flag;
    // this one is the thing that actually cost a capture — `DOMParser.parseFromString`
    // refusing a plain string under `require-trusted-types-for`. Proving the
    // blank-page path works here means it is known-good before the open is spent,
    // rather than discovered during it.
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    const parser = await context.newPage();
    await parser.goto('about:blank');

    section('Parse check — opens nothing');
    // A minimal body of each shape, built here so the check does not depend on
    // any capture existing. Both branches of the parser are exercised, which is
    // the point: the XML branch had never run against a real body, and the check
    // is only worth anything if it covers the path that is actually at risk.
    const sampleJson3 = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'rehearsal sentence one' }] },
        { tStartMs: 1200, dDurationMs: 900, segs: [{ utf8: 'rehearsal sentence two' }] },
      ],
    });
    const samples = [
      ['json3', sampleJson3],
      ['xml', xmlFromJson3(sampleJson3)],
    ];
    let parseFailed = 0;
    for (const [name, body] of samples) {
      try {
        const parsed = await parseCaptionBodyInPage(parser, body);
        const ok = parsed.length > 0;
        if (!ok) parseFailed++;
        console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name} body parsed (${parsed.length} cue${parsed.length === 1 ? '' : 's'})`);
      } catch (error) {
        parseFailed++;
        console.log(`  FAIL  ${name} body threw: ${error?.message ?? error}`);
      }
    }
    await context.close();
    await browser.close();

    if (parseFailed) {
      console.log('\n  the parser cannot run on a blank page — a capture would lose every body.');
      process.exit(1);
    }
    console.log('\n  the parser works where the capture will run it.');
    console.log('\n  Run `npm run capture` to spend the open.\n');
    process.exit(0);
  }
  console.log('');
}

// --- Replay ------------------------------------------------------------------

/**
 * Serve a previous capture back to the tool, so the whole pipeline can run with
 * the network stubbed.
 *
 * This is the rehearsal that was missing. It exercises routing, staging, parsing,
 * the normalised writes and the shape report — everything except the one thing
 * that genuinely cannot be rehearsed, which is what YouTube chooses to send. A
 * real run should be the first time the tool sees live data, not the first time it
 * runs at all.
 *
 * Anything the previous capture does not cover is answered with an empty body on
 * purpose, so the empty-from-both-paths branch is exercised too.
 *
 * @param {object} context
 * @param {string} sourceDir
 */
async function installReplayRoutes(context, sourceDir) {
  const rawDir = join(sourceDir, 'raw');
  const files = existsSync(rawDir) ? await readdir(rawDir) : [];

  // Which caption bodies the capture actually holds, by format.
  //
  // The rehearsal serves the REAL bodies. It used to synthesise the XML from a
  // JSON3 body, because no capture had ever held a default-format body — and then
  // one did, and the synthesiser silently produced nothing, because it was handed
  // real XML and expected JSON. A rehearsal whose input is built from an assumption
  // breaks the moment the assumption changes; serving reality cannot.
  const bodyFiles = files.filter((f) => f.endsWith('.txt') && /^captions-/.test(f));
  const readBody = (f) => (f ? readFileSync(join(rawDir, f), 'utf8') : '');
  const firstWith = (needle) => bodyFiles.find((f) => f.includes(needle));

  const realJson3 = readBody(firstWith('-json3.txt'));
  const realDefault = readBody(firstWith('-default.txt'));
  const realTranslated = readBody(firstWith('-tlang-'));

  // Two rehearsal-only cues, spliced into an XML body so entity decoding and
  // child-element flattening are exercised deterministically. They are appended to
  // whatever XML we serve — real or synthesised — because the real body cannot be
  // relied on to contain an entity or a nested element on any given day.
  const withRehearsalCues = (xml) =>
    xml.includes('</transcript>')
      ? xml.replace(
          '</transcript>',
          `  <text start="0" dur="0.1">${REHEARSAL_ENTITY}</text>\n  <text start="0" dur="0.1">${REHEARSAL_MARKUP}</text>\n</transcript>`,
        )
      : xml;

  // The default-format body — what YouTube sends with no `fmt`. The real one when
  // the capture has it; otherwise SYNTHESISED from json3 so the XML branch still
  // executes. A rehearsal that skips the branch it exists to rehearse is pointless,
  // so on a fresh json3-only capture we build the stand-in rather than serve
  // nothing. It is never written to a fixture and cannot be mistaken for captured.
  const defaultBody = realDefault ? withRehearsalCues(realDefault) : withRehearsalCues(xmlFromJson3(realJson3));

  const watchHtml = existsSync(join(rawDir, '00-watch.html'))
    ? readFileSync(join(rawDir, '00-watch.html'), 'utf8')
    : '<!doctype html><title>replay</title><video id="player"></video>';
  // Fall back to the web response when there is no ANDROID one, and accept the
  // name an EARLIER capture used. Both matter for the same reason: the shape is
  // what matters here, and skipping these branches would mean the first real run
  // is the first time they ever execute. That is the mistake this mode exists to
  // prevent, so it must not itself have an untested path.
  const playerFile = [
    'android-player-response.json',
    'web-player-response.json',
    'initial-player-response.json',
  ]
    .map((name) => join(rawDir, name))
    .find((path) => existsSync(path));
  const android = playerFile ? readFileSync(playerFile, 'utf8') : '{}';

  // Fail closed FIRST, so nothing can reach the network during a rehearsal.
  await context.route('**', (route) => route.abort());
  // The charset is not optional. Playwright's `contentType` is sent verbatim, and
  // a page served without one is decoded as Latin-1 — so the replayed title came
  // back as mojibake (`ä¸å›½æ—…æ¸¸` for 中国旅游) even though the bytes on disk
  // were correct UTF-8. YouTube sends a charset; the rehearsal has to as well, or
  // it exercises a page that differs from the real one.
  await context.route('**/watch**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: watchHtml }),
  );
  await context.route('**/youtubei/v1/player**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: android }),
  );

  // The caption route answers according to what was ASKED FOR, because that is
  // what the real site does and what the tool is trying to learn — but it answers
  // with the REAL bodies the capture holds, not with reconstructions of them.
  //
  //   - `fmt=json3` → the captured JSON3 body
  //   - no `fmt`     → the captured default-format (XML) body
  //   - `tlang=…`    → the captured translated body
  //
  // Anything not captured is answered from the closest real body rather than with
  // an empty one, so a branch that has never run still runs. Serving empty here
  // would make the rehearsal quietly vacuous, which is worse than a stand-in
  // because it looks like a pass.
  await context.route('**/api/timedtext**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const fmt = params.get('fmt');
    const tlang = params.get('tlang');
    const body = tlang && realTranslated ? realTranslated : fmt === 'json3' ? realJson3 : defaultBody;
    return route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body,
    });
  });
}

// --- Capture -----------------------------------------------------------------

/**
 * One caption URL, with `fmt` and `tlang` under our control.
 *
 * @param {object} page
 * @param {string} baseUrl
 * @param {'json3'|null} fmt
 * @param {string|null} tlang
 * @returns {Promise<{ok: boolean, status?: number, contentType?: string, body: string, error?: string|null}>}
 */
async function fetchCaption(page, baseUrl, fmt, tlang) {
  return page.evaluate(
    async ({ href, format, translate }) => {
      try {
        const url = new URL(href);
        // Explicitly DELETE when we want the default, so we learn what YouTube
        // sends when nobody asks for a format — the shape our parser has never
        // seen, because every previous call set `fmt=json3`.
        if (format) url.searchParams.set('fmt', format);
        else url.searchParams.delete('fmt');
        if (translate) url.searchParams.set('tlang', translate);
        else url.searchParams.delete('tlang');

        const response = await fetch(url.toString(), { credentials: 'include' });
        return {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          body: await response.text(),
          error: null,
        };
      } catch (error) {
        return { ok: false, status: 0, contentType: '', body: '', error: String(error?.message ?? error) };
      }
    },
    { href: baseUrl, format: fmt, translate: tlang },
  );
}

/**
 * A fresh player response from the ANDROID client the extension's fallback uses.
 *
 * @param {object} page
 * @param {string} videoId
 * @param {string|null} key
 * @returns {Promise<{body: string, error: string|null}>}
 */
async function fetchAndroidPlayer(page, videoId, key) {
  if (!key) return { body: '', error: 'no INNERTUBE key on the page' };
  return page.evaluate(
    async ({ id, apiKey }) => {
      try {
        const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: {
              client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' },
            },
            videoId: id,
          }),
        });
        if (!response.ok) return { body: '', error: `HTTP ${response.status}` };
        return { body: await response.text(), error: null };
      } catch (error) {
        return { body: '', error: String(error?.message ?? error) };
      }
    },
    { id: videoId, apiKey: key },
  );
}

/**
 * Parse a caption body the way the extension does.
 *
 * Runs in a BLANK page the tool owns, never in the YouTube page.
 *
 * The YouTube page enforces `require-trusted-types-for`, which makes
 * `parseFromString` refuse a plain string — the failure that cost a capture. A
 * page we create carries no such policy. It is still the platform's DOMParser and
 * `textContent`, so agreement with the extension is structural rather than
 * approximate, and independent of the extension's own code.
 *
 * @param {object} page A blank page. Named `page` for the call sites.
 * @param {string} body
 * @returns {Promise<Array<object>>}
 */
async function parseCaptionBodyInPage(page, body) {
  return page.evaluate((raw) => {
    const text = raw.trim();
    if (!text) return [];

    if (text.startsWith('{')) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return [];
      }
      return (json.events ?? [])
        .filter((event) => Array.isArray(event.segs))
        .map((event) => ({
          start: (event.tStartMs ?? 0) / 1000,
          duration: (event.dDurationMs ?? 0) / 1000,
          text: event.segs.map((s) => s.utf8 ?? '').join('').replace(/\n/g, ' ').trim(),
        }))
        .filter((segment) => segment.text.length > 0);
    }

    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    return [...doc.querySelectorAll('text')]
      .map((node) => ({
        start: Number.parseFloat(node.getAttribute('start') ?? '0') || 0,
        duration: Number.parseFloat(node.getAttribute('dur') ?? '0') || 0,
        // Exactly what the extension gets: entities decoded, tags flattened.
        text: (node.textContent ?? '').replace(/\n/g, ' ').trim(),
      }))
      .filter((segment) => segment.text.length > 0);
  }, body);
}

/**
 * Write the two manifests that describe a capture.
 *
 * Split out and called REPEATEDLY — after the player responses and after every
 * collected body — rather than once at the end. A capture is single-shot, so a run
 * that dies part-way must still be able to say what it got: the previous version
 * wrote these after the whole loop, so a mid-loop failure left bodies on disk with
 * nothing that named them, and the most informative run was the emptiest.
 *
 * Rewriting on each step is cheap and makes the staging directory readable at any
 * moment, including from a process that was killed.
 *
 * @param {string} normalised The capture's `normalised/` directory.
 * @param {object} summary The in-progress summary.
 */
async function writeManifests(normalised, summary) {
  await writeFile(
    join(normalised, 'video.json'),
    `${JSON.stringify(
      {
        videoId: summary.videoId,
        title: summary.title,
        isLive: summary.isLive,
        capturedAt: summary.capturedAt,
        consentWall: summary.consentWall,
        trackList: summary.tracks.map((t) => ({
          languageCode: t.languageCode,
          name: t.name,
          kind: t.kind,
          isTranslatable: t.isTranslatable,
        })),
        translationLanguages: summary.translationLanguages,
      },
      null,
      2,
    )}\n`,
  );

  // The structural report: keys, types and counts only. No content, which is what
  // makes it safe to commit and useful to diff.
  await writeFile(
    join(normalised, 'shape-report.json'),
    `${JSON.stringify(
      { ...summary.shapes, collection: summary.collection.map((c) => ({ ...c, bytes: c.bytes })) },
      null,
      2,
    )}\n`,
  );
}

/**
 * Keep a failed run's staging somewhere it can be found and derived from.
 *
 * A failed capture must not be an empty one — there may be no second attempt, so
 * whatever was fetched before the failure is the only evidence that will ever
 * exist. Copying (not moving) into a `.partial/` sibling means the good capture is
 * untouched, the partial is nameable, and `derive-synthetic` can merge the two.
 *
 * @param {string} videoId
 * @returns {Promise<string|null>} The partial path, or null if there was nothing.
 */
async function promotePartial(videoId) {
  const staging = join(STAGING, videoId);
  if (!existsSync(staging)) return null;
  if (!(await readdir(staging)).length) return null;

  const partial = join(FIXTURES, `${videoId}.partial`);
  await rm(partial, { recursive: true, force: true });
  await cp(staging, partial, { recursive: true });
  return partial;
}

/**
 * Capture one video.
 *
 * Writes into a staging directory and is only moved into place on success. The
 * ordering matters: the previous version cleared the destination first, so a
 * failure part-way through destroyed the only copy of a capture that costs a page
 * load to obtain.
 *
 * @param {object} context
 * @param {string} videoId
 * @param {{replay?: boolean, opened: {count: number}}} options
 * @returns {Promise<object>} A summary of what was captured.
 */
async function captureVideo(context, videoId, { replay = false, opened }) {
  const staging = join(STAGING, videoId);
  const target = join(FIXTURES, videoId);
  await rm(staging, { recursive: true, force: true });
  const raw = join(staging, 'raw');
  const normalised = join(staging, 'normalised');
  await mkdir(raw, { recursive: true });
  await mkdir(normalised, { recursive: true });

  const page = await context.newPage();

  // A SEPARATE, blank page, used only for parsing.
  //
  // Not a convenience. Parsing was being done with `page.evaluate` on the
  // YouTube page, and YouTube serves `require-trusted-types-for`, which forbids
  // handing a plain string to `DOMParser.parseFromString`. That threw and cost a
  // capture. A page this tool creates has no policy of its own, so the parser runs
  // where nothing forbids it — and it still uses the platform's DOMParser and
  // `textContent`, so it agrees with the extension structurally rather than by
  // approximation.
  //
  // `about:blank` rather than a served document, because there is then no policy
  // to inherit and nothing to go stale.
  const parser = await context.newPage();
  await parser.goto('about:blank');

  /** Everything the page asked YouTube for, in arrival order. */
  const responses = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!/youtube\.com\/(watch|youtubei\/v1\/player|api\/timedtext)/.test(url)) return;
    try {
      responses.push({
        url,
        status: response.status(),
        body: await response.body(),
        // Headers, not just the body. The policy that broke a capture —
        // `require-trusted-types-for` — arrived as a HEADER, so a tool that saved
        // only bodies left the cause invisible even after the fact. Anything we
        // might later need to reason about has to be in the record.
        headers: response.headers(),
      });
    } catch {
      // A response can be gone by the time we ask (redirects, aborted requests).
    }
  });

  // The ONE open. Counted so the run can report it rather than quietly spend
  // another.
  opened.count++;
  await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded' });
  // The page sets up `ytInitialPlayerResponse` with its own scripts, so reading
  // it immediately would see the DOM before the data.
  await page.waitForTimeout(PAGE_SETTLE_MS);

  const probe = await page.evaluate(() => {
    const response = window.ytInitialPlayerResponse;
    const renderer = response?.captions?.playerCaptionsTracklistRenderer;
    return {
      title: document.title,
      videoTitle: response?.videoDetails?.title ?? null,
      isLive: Boolean(response?.videoDetails?.isLiveContent),
      tracks: (renderer?.captionTracks ?? []).map((track) => ({
        languageCode: track.languageCode,
        name: track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? null,
        kind: track.kind ?? null,
        vssId: track.vssId ?? null,
        isTranslatable: Boolean(track.isTranslatable),
        baseUrl: track.baseUrl ?? null,
      })),
      translationLanguages: (renderer?.translationLanguages ?? []).map((language) => ({
        languageCode: language.languageCode,
        name: language.languageName?.runs?.[0]?.text ?? language.languageName?.simpleText ?? null,
      })),
      innertubeKey: window.ytcfg?.get?.('INNERTUBE_API_KEY') ?? null,
      consentWall: /consent|before you continue|not a bot/i.test(document.body?.innerText?.slice(0, 600) ?? ''),
    };
  });

  const summary = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    capturedAt: new Date().toISOString(),
    replay,
    title: probe.videoTitle ?? probe.title,
    isLive: probe.isLive,
    consentWall: probe.consentWall,
    tracks: probe.tracks.map(({ baseUrl, ...rest }) => rest),
    translationLanguages: probe.translationLanguages,
    files: [],
    collection: [],
    shapes: {},
  };

  // A consent or bot-check screen means the open is already spent and there is
  // nothing here worth asking for. Bail out BEFORE the android player request and
  // the whole collection loop — there is no point spending a dozen requests
  // against a page that is not the video, and a run that does looks like work.
  if (probe.consentWall) {
    console.log('    !! consent or bot-check screen — no video on the page');
    console.log('    !! stopping here rather than spending requests on it');
    summary.collection.push({ name: 'aborted', note: 'consent or bot-check screen' });
    await writeManifests(normalised, summary);
    await page.close();
    await parser.close();
    return summary;
  }

  // Manifest written before anything else can fail, so even a run that dies here
  // leaves something that names the video and its tracks.
  await writeManifests(normalised, summary);

  // The page's own player response, verbatim — what the bridge reads.
  const pageResponse = await page.evaluate(() => JSON.stringify(window.ytInitialPlayerResponse ?? null));
  if (pageResponse && pageResponse !== 'null') {
    await writeFile(join(raw, 'web-player-response.json'), pageResponse);
    summary.shapes.webPlayerResponse = rendererReport(JSON.parse(pageResponse));
  }

  // A FRESH response from the ANDROID client the extension's fallback uses. Two
  // clients can serve different track lists, and the fallback's correctness rests
  // entirely on this one — so it is worth having even though the page response
  // already has tracks.
  const android = await fetchAndroidPlayer(page, videoId, probe.innertubeKey);
  let androidTracks = [];
  if (android.body) {
    await writeFile(join(raw, 'android-player-response.json'), android.body);
    try {
      const parsed = JSON.parse(android.body);
      summary.shapes.androidPlayerResponse = rendererReport(parsed);
      androidTracks = parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    } catch (error) {
      console.log(`    ! android response was not JSON: ${error?.message ?? error}`);
    }
  } else {
    console.log(`    ! android player response unavailable: ${android.error}`);
  }

  // Both player responses are on disk now; record them before the collection loop
  // starts, so a failure inside the loop still leaves the track lists behind.
  await writeManifests(normalised, summary);

  // Raw transport traffic, for the record.
  let rawIndex = 0;
  for (const captured of responses) {
    const kind = captured.url.includes('/api/timedtext')
      ? 'timedtext'
      : captured.url.includes('/youtubei/v1/player')
        ? 'player'
        : 'watch';
    const extension = kind === 'watch' ? 'html' : 'txt';
    const file = `${String(rawIndex++).padStart(2, '0')}-${kind}.${extension}`;
    await writeFile(join(raw, file), captured.body);
    summary.files.push({
      file: `raw/${file}`,
      kind,
      url: scrubUrl(captured.url),
      status: captured.status,
      bytes: captured.body.length,
    });

    // Headers alongside the body, so the conditions the response carried are part
    // of the record rather than something to rediscover.
    const headerFile = `${file}.headers.json`;
    await writeFile(join(raw, headerFile), `${JSON.stringify(captured.headers ?? {}, null, 2)}\n`);
  }

  // Pick one language to translate into, for the translated-body shape.
  const translateTo =
    probe.translationLanguages.find((l) => l.languageCode === 'en')?.languageCode ??
    probe.translationLanguages[0]?.languageCode ??
    null;

  // Every body shape, in the one page load.
  //
  // Each request is isolated. The previous version only guarded the PARSE, so a
  // throw from `fetchCaption` or a write — a navigation, a closed page, a transient
  // failure on the fourth of twelve requests — abandoned the loop and every body
  // still to come. One request failing must cost one request.
  let attempted = 0;
  const plan = collectionPlan(probe.tracks, translateTo);
  if (plan.length > MAX_REQUESTS) {
    // Reported rather than silently truncated, because a plan larger than the cap
    // means the shape of the plan changed and the cap is now arbitrary.
    console.warn(
      `    ! the plan wants ${plan.length} requests, over the ${MAX_REQUESTS} cap — the first ${MAX_REQUESTS} will be made`,
    );
  }

  for (const request of plan) {
    if (attempted >= MAX_REQUESTS) {
      summary.collection.push({
        note: `stopped at the ${MAX_REQUESTS}-request cap; ${plan.length - attempted} request(s) not made`,
      });
      console.log(`    ! stopped at the ${MAX_REQUESTS}-request cap`);
      break;
    }

    const source = request.client === 'android' ? androidTracks : probe.tracks;
    const track = source.find((t) => t.languageCode === request.track.languageCode);
    const label = requestLabel(request);

    // A rehearsal of the failure path: throw exactly as a real mid-loop failure
    // would, so the code that keeps and names the partial actually runs.
    if (replay && Number.isInteger(FAIL_AFTER) && attempted >= FAIL_AFTER) {
      throw new Error(`injected failure after ${FAIL_AFTER} request(s) (--fail-after)`);
    }

    if (!track?.baseUrl) {
      summary.collection.push({ ...describeRequest(request), note: 'no baseUrl from this client' });
      await writeManifests(normalised, summary);
      continue;
    }

    attempted++;
    let result;
    try {
      // Bounded, so one request that never answers cannot hold the whole capture
      // open. A timeout is recorded like any other failure and the loop carries on.
      result = await withTimeout(
        fetchCaption(page, track.baseUrl, request.fmt, request.tlang),
        REQUEST_TIMEOUT_MS,
        `${label} timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    } catch (error) {
      const note = String(error?.message ?? error);
      summary.collection.push({ ...describeRequest(request), ok: false, status: 0, bytes: 0, shape: null, file: null, note });
      await writeManifests(normalised, summary);
      console.log(`    ${label}: ERR — ${note}`);
      continue;
    }

    const entry = {
      ...describeRequest(request),
      ok: result.ok,
      status: result.status,
      contentType: result.contentType,
      bytes: result.body.length,
      shape: null,
      file: null,
      note: null,
    };

    // --- Stop the whole run the moment we are refused --------------------------
    //
    // The previous version carried on through a rate limit and recorded every
    // subsequent response as an ordinary body. 56 block pages were written to disk
    // as though they were capture data, and because a block page parses to zero
    // cues, the summary read as "this video has no captions" — a false conclusion
    // that cost hours of looking in the wrong place.
    //
    // Stopping is also the correct behaviour towards the server. Continuing to ask
    // after being told to stop is what turns a short rate limit into a longer one.
    // The partial capture is kept and named, so the requests already paid for are
    // not wasted.
    if (isRefusal(result)) {
      entry.shape = bodyShape(result.body);
      entry.note = `REFUSED (${result.status}) — stopping the run`;
      if (result.body.trim()) {
        await writeFile(join(raw, `${label}.txt`), result.body);
        entry.file = `raw/${label}.txt`;
      }
      summary.collection.push(entry);
      summary.refusedAt = { label, status: result.status, after: attempted };
      await writeManifests(normalised, summary);
      console.log(`    ${label}: REFUSED (${result.status}) — stopping. ${attempted} request(s) made.`);
      break;
    }

    if (result.body.trim()) {
      await writeFile(join(raw, `${label}.txt`), result.body);
      entry.file = `raw/${label}.txt`;
      // Classified by what the body IS, so a server ignoring `fmt` is recorded as
      // the disagreement it is rather than as the format we asked for.
      entry.shape = bodyShape(result.body);
      entry.formatMatches = formatMatches(entry.shape, request.fmt);

      // Parsed straight away, not just stored. Transport succeeding says nothing
      // about whether the PARSER handles the body — and the XML branch has never
      // executed against real data, so "it downloaded 28KB" is exactly the kind of
      // reassurance that hides a failure. Recording the cue count and whether any
      // markup survived makes the rehearsal prove the whole path, which is the
      // point of rehearsing at all.
      //
      // Parsed on the BLANK page, not this one: extracting a `require-trusted-types`
      // policy blindly is how the failure that cost a capture got through.
      let parsed = [];
      try {
        parsed = await parseCaptionBodyInPage(parser, result.body);
      } catch (error) {
        // Recorded and carried on. One body failing to parse must not throw away
        // every other body already fetched — that is the whole reason staging is
        // kept on failure.
        entry.note = `parse failed: ${error?.message ?? error}`;
        console.log(`    ! ${label}: ${entry.note}`);
      }
      entry.segments = parsed.length;
      entry.markupLeaked = parsed.some((segment) => /<[a-z/]/i.test(segment.text));
      entry.sample = parsed.slice(0, 2).map((segment) => segment.text);
      // Kept only for a rehearsal, so the synthetic cues can be checked against
      // what they were supposed to decode to. A real run does not carry this.
      if (replay) entry.parsedText = parsed.map((segment) => segment.text);
    } else if (result.ok) {
      // Not an error, and worth recording as its own finding: the direct URL
      // answering 200 with nothing is what sent the previous capture to the
      // fallback path.
      entry.note = 'HTTP 200 with an empty body';
    } else {
      entry.note = result.error ?? 'failed';
    }

    summary.collection.push(entry);
    // Flushed on every request, so a failure on the next one still leaves a
    // manifest describing everything collected so far.
    await writeManifests(normalised, summary);

    const bits = [result.ok ? `${result.status}` : 'ERR', `${result.body.length}B`, result.contentType ?? ''];
    const parsedCues = entry.shape ? ` → ${entry.segments} cues` : '';
    const leaked = entry.markupLeaked ? ' !! MARKUP LEAKED INTO TEXT' : '';
    const mismatch = entry.shape && entry.formatMatches === false ? ' !! FORMAT MISMATCH' : '';
    console.log(`    ${label}: ${bits.filter(Boolean).join(' ')}${entry.shape ? ` (${entry.shape})` : ''}${parsedCues}${leaked}${mismatch}${entry.note ? ` — ${entry.note}` : ''}`);
  }

  // --- Normalised: the segments a reviewer (and the replay tier) can read -----
  for (const track of probe.tracks) {
    // Pick the body whose format actually matches what was asked for, preferring
    // the default-format body — the shape we are structuring the whole capture
    // around — and falling back to json3 and then anything with content.
    //
    // Written to disk based on the STORED body, not the in-memory parse, so the
    // file a reviewer reads is the file that was checked.
    const stored = summary.collection.filter(
      (c) => c.languageCode === track.languageCode && c.file && !c.tlang && c.segments > 0,
    );
    const entry =
      stored.find((c) => c.format === 'default' && c.formatMatches) ??
      stored.find((c) => c.formatMatches && c.segments > 0) ??
      stored.find((c) => c.format === 'default') ??
      stored.find((c) => c.fmt === 'json3') ??
      stored[0];
    if (!entry) continue;

    // Parsed on the blank page, same as above.
    const parsed = await parseCaptionBodyInPage(parser, readFileSync(join(staging, entry.file), 'utf8')).catch(
      () => [],
    );
    const name = `captions-${track.languageCode}${track.kind === 'asr' ? '-asr' : ''}.json`;
    await writeFile(
      join(normalised, name),
      `${JSON.stringify(
        {
          languageCode: track.languageCode,
          kind: track.kind,
          // Which path and format produced this, because they are known to differ
          // and "it captured" would otherwise hide that the obvious one is empty.
          source: entry.client,
          format: entry.fmt ?? 'default',
          // What the body actually WAS, not what was asked for. The derive step
          // reads this to say honestly whether a real XML body has ever been seen.
          shape: entry.shape,
          segments: parsed,
        },
        null,
        2,
      )}\n`,
    );
    summary.files.push({ file: `normalised/${name}`, kind: 'captions', source: entry.client, segments: parsed.length });
  }

  // One last flush, now that the normalised segments and file list are in.
  await writeManifests(normalised, summary);

  await page.close();
  await parser.close();

  if (!replay) {
    // Only now, with a complete capture in hand, replace the destination. A
    // failure above leaves whatever was there untouched.
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  }

  return summary;
}

// --- Run ---------------------------------------------------------------------

if (!executablePath) {
  console.error('No Chromium able to load extensions was found. Set CHROME_PATH.');
  process.exit(1);
}

const opened = { count: 0 };

section(
  MODE_REPLAY
    ? 'Rehearsing against the existing capture — opens nothing'
    : `Capturing ${videoIds.length} video(s) — this opens youtube.com ${videoIds.length} time(s), and no more`,
);

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext();

if (MODE_REPLAY) await installReplayRoutes(context, join(FIXTURES, videoIds[0]));

const summaries = [];
for (const videoId of videoIds) {
  console.log(`\n  ${videoId}`);
  try {
    const summary = await captureVideo(context, videoId, { replay: MODE_REPLAY, opened });
    summaries.push(summary);

    if (summary.consentWall) {
      console.log('    !! the page was a consent or bot-check screen, not a video');
      console.log('    !! nothing useful was captured — that open is spent');
      continue;
    }
    console.log(`    ${summary.title}`);
    const tracks = summary.tracks.map((t) => t.languageCode + (t.kind === 'asr' ? '(asr)' : '')).join(', ');
    console.log(`    tracks: ${tracks || 'none'}`);
    console.log(`    translatable into: ${summary.translationLanguages.length} languages`);
    console.log(`    bodies collected:  ${summary.collection.filter((c) => c.file).length}/${summary.collection.length}`);
  } catch (error) {
    console.log(`    FAILED: ${error?.message ?? error}`);
    opened.failed = true;
    // Whatever was fetched before the failure is the only evidence that will
    // exist, so it is copied somewhere findable rather than left in `.staging`
    // where the next run's first line would delete it. The good capture is never
    // touched on a failure — that is the whole point of staging.
    const partial = await promotePartial(videoId).catch(() => null);
    if (partial) {
      console.log(`    partial results kept at: ${partial.slice(ROOT.length + 1)}`);
      console.log('    the existing capture was left untouched');
    }
  }
}

await context.close();
await browser.close();

section('Done');
console.log(`  pages opened: ${opened.count}`);
if (opened.count > videoIds.length) {
  console.log('  !! more pages were opened than videos asked for — this should be impossible');
}

// --- Rehearsal self-check ----------------------------------------------------
//
// A rehearsal that only prints is not a rehearsal. These assert the things the
// printout above can only suggest: that the XML branch parsed at all, that a
// request without `fmt` really took it, that entities were decoded, and that
// markup did not survive into the text. Any of those failing means the live run
// would be discovering it for the first time, which is what option 2 exists to
// prevent.
if (MODE_REPLAY) {
  const collection = summaries.flatMap((s) => s.collection ?? []);
  const checks = [];

  if (Number.isInteger(FAIL_AFTER)) {
    // --fail-after rehearses the FAILURE path. The happy-path assertions do not
    // apply — the loop was deliberately cut short — so what is checked instead is
    // that the partial was preserved and is self-describing, which is the code
    // path that had never run when the last shot was lost.
    const summary = summaries[0] ?? { collection: [] };
    const partial = join(FIXTURES, `${videoIds[0]}.partial`);
    // The partial is the only record — a thrown run returns no summary, so what it
    // collected has to be read back from the file on disk. That is the point: the
    // evidence must outlive the process.
    const partialShape = existsSync(join(partial, 'normalised', 'shape-report.json'))
      ? JSON.parse(readFileSync(join(partial, 'normalised', 'shape-report.json'), 'utf8'))
      : null;
    const collectedBeforeFailure = partialShape?.collection?.filter((c) => c.file).length ?? 0;

    checks.push(['the loop threw after the injected point', opened.failed === true]);
    checks.push([
      'the requests before the failure still ran',
      collectedBeforeFailure >= 1,
    ]);
    checks.push([
      'the partial was promoted and is self-describing',
      existsSync(join(partial, 'normalised', 'video.json')) && Boolean(partialShape),
    ]);
    checks.push([
      'the requests after the failure were NOT attempted',
      // Everything the partial holds came before the cut, so none of the later
      // requests ran. If this were false the injection did nothing.
      (summary.collection ?? []).length === 0,
    ]);

    section('Failure-path self-check');
    let failed = 0;
    for (const [name, ok] of checks) {
      console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
      if (!ok) failed++;
    }
    if (failed) {
      console.log(`\n  ${failed} check(s) failed — the partial-preservation path is broken.`);
      process.exitCode = 1;
    } else {
      console.log('\n  a mid-loop failure preserves and names its partial results.');
    }

    // Clean up the partial this run deliberately created; it is rehearsal debris,
    // not a real capture. Clearing the failure flag lets the ordinary staging
    // cleanup below run, so a rehearsal does not leave the "staging kept for
    // inspection" state that a real failure is supposed to have.
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    opened.failed = false;
  } else {
    const xmlEntries = collection.filter((c) => c.shape === 'xml');
    const jsonEntries = collection.filter((c) => c.shape === 'json3');
    checks.push(['both formats were served', xmlEntries.length > 0 && jsonEntries.length > 0]);
    checks.push(['every collected body produced cues', collection.filter((c) => c.file).every((c) => c.segments > 0)]);
    checks.push(['no markup leaked into any parsed text', collection.every((c) => !c.markupLeaked)]);
    // The response is the ground truth about its own format. If a server ignored
    // `fmt`, the capture must record the disagreement rather than the format we
    // hoped for — otherwise the one interesting finding is the one we cannot see.
    checks.push(['no request received a format other than the one asked for', collection.every((c) => c.formatMatches !== false)]);

    // The synthetic cues, checked against exactly what they must decode to. Only
    // the XML entries carry them.
    const anyXml = xmlEntries.length > 0;
    checks.push([
      'entity decoded (a single ampersand, not &amp;)',
      !anyXml || xmlEntries.some((c) => c.parsedText?.includes(REHEARSAL_EXPECTED[0])),
    ]);
    checks.push([
      'child element flattened (no tags in the text)',
      !anyXml || xmlEntries.some((c) => c.parsedText?.includes(REHEARSAL_EXPECTED[1])),
    ]);
    checks.push(['no raw entity survived', !collection.some((c) => c.parsedText?.some((t) => /&amp;|&lt;/.test(t)))]);

    section('Rehearsal self-check');
    let failed = 0;
    for (const [name, ok] of checks) {
      console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
      if (!ok) failed++;
    }
    if (failed) {
      console.log(`\n  ${failed} check(s) failed — the live run would be discovering this.`);
      process.exitCode = 1;
    } else {
      console.log('\n  every branch exercised offline. The live run should see nothing new.');
    }
  }
}

// Staging is cleaned up ONLY when nothing failed.
//
// This is the fix for the thing that hurt most: the capture that cost the shot
// fetched a real body, wrote it to staging, threw on the next branch, and then
// this line deleted the evidence along with everything else. A failed run should
// be the MOST informative one, not the emptiest — there may be no second attempt
// to gather what it found.
if (opened.count && opened.failed) {
  console.log(`\n  staging kept for inspection: ${join('test', 'fixtures', '.staging')}`);
  console.log('  whatever was fetched before the failure is still there.');
} else {
  await rm(STAGING, { recursive: true, force: true }).catch(() => {});
}

if (!MODE_REPLAY) {
  await writeFile(join(FIXTURES, 'index.json'), `${JSON.stringify(summaries, null, 2)}\n`);
  console.log(`  wrote ${join('test', 'fixtures', 'index.json')}`);
}
console.log('  fixtures are gitignored; they are local to this machine.\n');

console.log('  next: node tools/derive-synthetic.mjs  (derive committed synthetic fixtures)\n');
