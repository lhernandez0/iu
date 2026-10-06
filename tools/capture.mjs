/**
 * Capture a real YouTube video into fixtures.
 *
 *   node tools/capture.mjs <videoId> [more ids…]
 *
 * THE ONLY THING IN THIS PROJECT THAT OPENS youtube.com.
 *
 * That is the rule this tool exists to enforce. Every test — hermetic, replay,
 * anything added later — reads captured fixtures and never touches the network,
 * so "we hit the real site" is a thing you do deliberately, per video, and can
 * never happen as a side effect of running the suite.
 *
 * What it records, for one video, in one page load:
 *
 *   test/fixtures/<videoId>/raw/          exactly what YouTube sent
 *   test/fixtures/<videoId>/normalised/   the same, cleaned up and readable
 *
 * Both, on purpose. The raw bytes are the honest record — nothing about our
 * beliefs is in them, so they can falsify a wrong assumption rather than confirm
 * it. The normalised copies are what a person actually reads while reviewing,
 * because a fixture you cannot read is a fixture nobody checks. Tests read the
 * normalised form, since that is the one that stays stable across captures.
 *
 * Fixtures are LOCAL. They are gitignored: a raw capture contains a signed
 * caption URL — `signature`, `ei`, `ip`, `expire` — and that is a session
 * artifact, not something to put in a repository. Capture is therefore a setup
 * step, and each developer runs it for themselves.
 *
 * Runs are sequential and one browser at a time. There is no parallelism here by
 * design: the constraint is "touch the site as little as possible", not speed.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test', 'fixtures');

/** How long to let the real page boot its own scripts before reading it. */
const PAGE_SETTLE_MS = 5000;

/**
 * Query parameters that are session artifacts rather than part of the format.
 *
 * They are useless as credentials — `expire` is hours away at most — but they
 * are still someone's session, they make every re-capture look like a total
 * change, and there is no reason for them to be in a fixture. Dropped from the
 * normalised copy; the raw copy keeps everything, because the raw copy is the
 * record of what was actually sent.
 */
const VOLATILE_PARAMS = [
  'signature',
  'ei',
  'ip',
  'ipbits',
  'expire',
  'sparams',
  'pot',
  'potc',
  'c',
  'cver',
  'cplatform',
  'cbr',
  'cbrver',
  'cos',
  'cosver',
  'cplayer',
  'hl',
  'xorb',
  'xobt',
  'xovt',
  'xoaf',
  'clen',
  'dur',
  'lsparams',
  'lsig',
  'n',
];

/**
 * @param {string} url
 * @returns {string} The URL with session-scoped parameters removed.
 */
function scrubUrl(url) {
  try {
    const parsed = new URL(url);
    for (const param of VOLATILE_PARAMS) parsed.searchParams.delete(param);
    // Deterministic order, so re-captures diff cleanly.
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

/**
 * Capture one video.
 *
 * @param {object} context
 * @param {string} videoId
 * @returns {Promise<object>} A summary of what was captured.
 */
async function captureVideo(context, videoId) {
  const raw = join(FIXTURES, videoId, 'raw');
  const normalised = join(FIXTURES, videoId, 'normalised');
  await rm(join(FIXTURES, videoId), { recursive: true, force: true });
  await mkdir(raw, { recursive: true });
  await mkdir(normalised, { recursive: true });

  const page = await context.newPage();

  /** Everything the page asked YouTube for, in arrival order. */
  const responses = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!/youtube\.com\/(watch|youtubei\/v1\/player|api\/timedtext)/.test(url)) return;
    try {
      const body = await response.body();
      responses.push({ url, status: response.status(), body });
    } catch {
      // A response can be gone by the time we ask (redirects, aborted requests).
    }
  });

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
      resolvedVideoId: response?.videoDetails?.videoId ?? null,
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
      consentWall: /consent|before you continue|not a bot/i.test(document.body?.innerText?.slice(0, 600) ?? ''),
    };
  });

  const summary = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    capturedAt: new Date().toISOString(),
    title: probe.videoTitle ?? probe.title,
    isLive: probe.isLive,
    consentWall: probe.consentWall,
    tracks: probe.tracks.map((track) => ({
      languageCode: track.languageCode,
      name: track.name,
      kind: track.kind,
      vssId: track.vssId,
      isTranslatable: track.isTranslatable,
    })),
    translationLanguages: probe.translationLanguages,
    files: [],
  };

  // --- Raw: everything, untouched -------------------------------------------
  // Named by content type rather than by URL, because the URLs carry signatures
  // that change on every capture and would otherwise litter the directory.
  let rawIndex = 0;
  for (const response of responses) {
    const kind = response.url.includes('/api/timedtext')
      ? 'timedtext'
      : response.url.includes('/youtubei/v1/player')
        ? 'player'
        : 'watch';
    const extension = kind === 'watch' ? 'html' : 'txt';
    const file = `${String(rawIndex++).padStart(2, '0')}-${kind}.${extension}`;
    await writeFile(join(raw, file), response.body);
    summary.files.push({ file: `raw/${file}`, kind, url: scrubUrl(response.url), status: response.status(), bytes: response.body.length });
  }

  // The player response as the page itself holds it, which is what the bridge
  // reads and therefore the thing worth having verbatim.
  const playerResponse = await page.evaluate(() => JSON.stringify(window.ytInitialPlayerResponse ?? null));
  if (playerResponse && playerResponse !== 'null') {
    await writeFile(join(raw, 'initial-player-response.json'), playerResponse);
    summary.files.push({ file: 'raw/initial-player-response.json', kind: 'player-response', bytes: playerResponse.length });
  }

  // --- Normalised: the shape we depend on, readable -------------------------
  await writeFile(
    join(normalised, 'video.json'),
    `${JSON.stringify(
      {
        videoId: summary.videoId,
        title: summary.title,
        isLive: summary.isLive,
        capturedAt: summary.capturedAt,
        // Every field the extension actually reads, so a reviewer can see the
        // contract without opening the raw blobs.
        trackList: summary.tracks.map((track) => ({
          languageCode: track.languageCode,
          name: track.name,
          kind: track.kind,
          isTranslatable: track.isTranslatable,
        })),
        translationLanguages: summary.translationLanguages,
      },
      null,
      2,
    )}\n`,
  );

  // Each caption track, parsed into the segments the extension would end up with.
  // A reviewer can read this, and the raw file beside it says whether we parsed
  // it correctly — which is the whole reason both are kept.
  for (const track of probe.tracks) {
    if (!track.baseUrl) continue;
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');

    // Parsed IN THE PAGE, with the browser's own DOMParser and `textContent`.
    //
    // Not for convenience — for correctness. The extension's parser assigns
    // `textContent`, which per the DOM spec decodes entities AND concatenates
    // every text descendant. A Node-side regex cannot reproduce that: it would
    // either keep `&amp;#39;` encoded, or keep `<i>` tags the extension strips,
    // and either way the fixture would describe text the extension never sees.
    // Using the platform's parser makes agreement structural rather than
    // approximate, while staying independent of the extension's own code.
    const result = await page.evaluate(async (href) => {
      const response = await fetch(href, { credentials: 'include' });
      if (!response.ok) return { error: `FETCH_FAILED ${response.status}`, segments: [], markup: 0 };
      const text = (await response.text()).trim();
      if (!text) return { error: null, segments: [], markup: 0 };

      // JSON3: field mapping only, nothing to parse.
      if (text.startsWith('{')) {
        try {
          const json = JSON.parse(text);
          const segments = (json.events ?? [])
            .filter((event) => Array.isArray(event.segs))
            .map((event) => ({
              start: (event.tStartMs ?? 0) / 1000,
              duration: (event.dDurationMs ?? 0) / 1000,
              text: event.segs
                .map((seg) => seg.utf8 ?? '')
                .join('')
                .replace(/\n/g, ' ')
                .trim(),
            }))
            .filter((segment) => segment.text.length > 0);
          return { error: null, segments, markup: 0 };
        } catch (error) {
          return { error: String(error?.message ?? error), segments: [], markup: 0 };
        }
      }

      const doc = new DOMParser().parseFromString(text, 'text/xml');
      if (doc.querySelector('parsererror')) return { error: 'XML parse error', segments: [], markup: 0 };

      let markup = 0;
      const segments = [...doc.querySelectorAll('text')]
        .map((node) => {
          // Any child element is markup the platform is about to flatten.
          if (node.children.length) markup++;
          return {
            start: Number.parseFloat(node.getAttribute('start') ?? '0') || 0,
            duration: Number.parseFloat(node.getAttribute('dur') ?? '0') || 0,
            // Exactly what the extension gets. Entities decoded, tags flattened.
            text: (node.textContent ?? '').replace(/\n/g, ' ').trim(),
          };
        })
        .filter((segment) => segment.text.length > 0);
      return { error: null, segments, markup };
    }, url.toString());

    if (result.error) console.log(`    ! ${track.languageCode}: ${result.error}`);
    if (result.markup) {
      console.log(`    ! ${track.languageCode}: ${result.markup} cue(s) contained markup, now flattened`);
    }

    const name = `captions-${track.languageCode}${track.kind === 'asr' ? '-asr' : ''}.json`;
    await writeFile(
      join(normalised, name),
      `${JSON.stringify(
        { languageCode: track.languageCode, kind: track.kind, segments: result.segments },
        null,
        2,
      )}\n`,
    );
    summary.files.push({ file: `normalised/${name}`, kind: 'captions', segments: result.segments.length, markup: result.markup });
  }

  await page.close();
  return summary;
}

// --- Entry ------------------------------------------------------------------

const videoIds = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
if (!videoIds.length) {
  console.error('Usage: node tools/capture.mjs <videoId> [more ids…]');
  console.error('');
  console.error('Records a real YouTube video into test/fixtures/<videoId>/.');
  console.error('This is the ONLY command in the project that opens youtube.com.');
  process.exit(1);
}

const executablePath = findChrome();
if (!executablePath) {
  console.error('No Chromium able to load extensions was found. Set CHROME_PATH.');
  process.exit(1);
}

section(`Capturing ${videoIds.length} video(s) — this opens youtube.com ${videoIds.length} time(s)`);

const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext();

const summaries = [];
for (const videoId of videoIds) {
  console.log(`\n  ${videoId}`);
  try {
    const summary = await captureVideo(context, videoId);
    summaries.push(summary);

    if (summary.consentWall) {
      console.log('    !! the page was a consent or bot-check screen, not a video');
      console.log('    !! nothing useful was captured — try again from a different network');
      continue;
    }
    console.log(`    ${summary.title}`);
    const tracks = summary.tracks.map((t) => t.languageCode + (t.kind === 'asr' ? '(asr)' : '')).join(', ');
    console.log(`    tracks: ${tracks || 'none'}`);
    console.log(`    translatable into: ${summary.translationLanguages.length} languages`);
    console.log(`    files: ${summary.files.length}`);
  } catch (error) {
    console.log(`    FAILED: ${error?.message ?? error}`);
  }
}

await context.close();
await browser.close();

section('Done — the browser is closed and will not be opened again unless you ask');

await writeFile(join(FIXTURES, 'index.json'), `${JSON.stringify(summaries, null, 2)}\n`);
console.log(`\n  wrote ${join('test', 'fixtures', 'index.json')}`);
console.log('  fixtures are gitignored; they are local to this machine.\n');
