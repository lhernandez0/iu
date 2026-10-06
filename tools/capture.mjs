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
 * our XML parser has never once seen a real XML body, because `fmt=json3` has
 * always been forced. Guessing at either from a hand-written fixture is how we
 * ended up with tests that describe YouTube as we imagine it.
 *
 * Fixtures are LOCAL and gitignored: a raw capture contains a signed caption URL
 * (`signature`, `ei`, `ip`, `expire`), which is a session artifact rather than
 * something to put in a repository. The committed counterpart is
 * `test/synthetic/` — our own invented content, shaped by a structural report
 * derived from a real capture. That is what the tests read.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rename, rm, readdir } from 'node:fs/promises';
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
 * The list is exhaustive rather than minimal because a capture is a single-shot
 * resource: any question not answered here costs another page load, which is the
 * thing this tool exists to avoid.
 *
 * `client` is which player response supplies the URL — the page's own initial
 * response, or a fresh ANDROID-client one. They can disagree, and the extension
 * uses both.
 *
 * @param {object[]} tracks
 * @param {string|null} translateTo
 * @returns {Array<{name: string, track: object, client: 'page'|'android', fmt: 'json3'|null, tlang: string|null}>}
 */
function collectionPlan(tracks, translateTo) {
  const plan = [];
  for (const track of tracks) {
    for (const fmt of ['json3', null]) {
      for (const client of ['page', 'android']) {
        plan.push({
          name: `${client} client, ${fmt ?? 'default format'}`,
          track,
          client,
          fmt,
          tlang: null,
        });
      }
    }
    // One translation per translatable track is enough to learn the shape; the
    // target language is recorded so it is reproducible.
    if (translateTo && track.isTranslatable) {
      plan.push({
        name: `translated to ${translateTo}`,
        track,
        client: 'android',
        fmt: 'json3',
        tlang: translateTo,
      });
    }
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

/**
 * Whether a caption body is JSON3 or XML, as a word.
 *
 * @param {string} body
 * @returns {string}
 */
function captionBodyShape(body) {
  const text = body.trim();
  if (text.startsWith('{')) return 'json3';
  if (text.startsWith('<')) return 'xml';
  return 'unknown';
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
 * Rebuild a captured JSON3 body in the XML shape YouTube sends when nobody asks
 * for a format.
 *
 * REHEARSAL ONLY — this never runs against the network and never writes a fixture.
 * Its whole purpose is to let `--replay` exercise the XML branch of the parser,
 * which no capture we hold can exercise: every body we have was requested with
 * `fmt=json3`, so the default-format path has never executed at all. Discovered
 * on the live run means a wasted open, and the open is not repeatable.
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

  // Prefer a JSON3 body, then any caption body at all. Being generous here is the
  // point: a rehearsal that finds no bodies exercises only the empty path, and
  // then the first real run is the first time the success path is tried — which
  // is exactly the mistake this mode exists to prevent. It bit once already: the
  // first version matched on a filename containing `json3`, and the captured
  // files are named by client instead, so every request came back empty.
  const captionBody = () => {
    const candidates = files.filter((f) => f.endsWith('.txt') && /captions/i.test(f));
    const preferred =
      candidates.find((f) => /innertube/i.test(f) && /json3/i.test(f)) ??
      candidates.find((f) => /innertube/i.test(f)) ??
      candidates[0];
    return preferred ? readFileSync(join(rawDir, preferred), 'utf8') : '';
  };

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
  // what the real site does and what the tool is trying to learn.
  //
  // A request with `fmt=json3` gets JSON3. A request with no `fmt` gets XML built
  // from the same cues — the shape YouTube sends by default, which no capture we
  // hold contains, because every previous call asked for json3. Answering both the
  // same way would leave the XML branch unexecuted until the live run, which is
  // the one place a surprise is expensive.
  const json3 = captionBody();
  const xml = xmlFromJson3(json3);

  await context.route('**/api/timedtext**', (route) => {
    const wantsJson3 = new URL(route.request().url()).searchParams.get('fmt') === 'json3';
    return route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: wantsJson3 ? json3 : xml,
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
  for (const request of collectionPlan(probe.tracks, translateTo)) {
    const source = request.client === 'android' ? androidTracks : probe.tracks;
    const track = source.find((t) => t.languageCode === request.track.languageCode);
    const label = requestLabel(request);

    if (!track?.baseUrl) {
      summary.collection.push({ ...describeRequest(request), note: 'no baseUrl from this client' });
      continue;
    }

    const result = await fetchCaption(page, track.baseUrl, request.fmt, request.tlang);
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

    if (result.body.trim()) {
      await writeFile(join(raw, `${label}.txt`), result.body);
      entry.file = `raw/${label}.txt`;
      entry.shape = captionBodyShape(result.body);

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
    const bits = [result.ok ? `${result.status}` : 'ERR', `${result.body.length}B`, result.contentType ?? ''];
    const parsed = entry.shape ? ` → ${entry.segments} cues` : '';
    const leaked = entry.markupLeaked ? ' !! MARKUP LEAKED INTO TEXT' : '';
    console.log(`    ${label}: ${bits.filter(Boolean).join(' ')}${entry.shape ? ` (${entry.shape})` : ''}${parsed}${leaked}${entry.note ? ` — ${entry.note}` : ''}`);
  }

  // --- Normalised: the segments a reviewer (and the replay tier) can read -----
  for (const track of probe.tracks) {
    // Prefer a json3 body that actually had content; fall back to anything.
    // AND the normalised form, read from the stored body rather than from the
    // in-memory parse, so the file on disk is the thing that is checked.
    const stored = summary.collection.filter((c) => c.languageCode === track.languageCode && c.file && !c.tlang);
    const entry = stored.find((c) => c.fmt === 'json3') ?? stored[0];
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
          segments: parsed,
        },
        null,
        2,
      )}\n`,
    );
    summary.files.push({ file: `normalised/${name}`, kind: 'captions', source: entry.client, segments: parsed.length });
  }

  await writeFile(
    join(normalised, 'video.json'),
    `${JSON.stringify(
      {
        videoId: summary.videoId,
        title: summary.title,
        isLive: summary.isLive,
        capturedAt: summary.capturedAt,
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
    `${JSON.stringify({ ...summary.shapes, collection: summary.collection.map((c) => ({ ...c, bytes: c.bytes })) }, null, 2)}\n`,
  );

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

  const xmlEntries = collection.filter((c) => c.shape === 'xml');
  const jsonEntries = collection.filter((c) => c.shape === 'json3');
  checks.push(['both formats were served', xmlEntries.length > 0 && jsonEntries.length > 0]);
  checks.push(['every collected body produced cues', collection.filter((c) => c.file).every((c) => c.segments > 0)]);
  checks.push(['no markup leaked into any parsed text', collection.every((c) => !c.markupLeaked)]);

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
