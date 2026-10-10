/**
 * Browser-test scaffolding: launch the real extension, serve a fake YouTube,
 * drive the real panel.
 *
 * Nothing here is stubbed in JavaScript. The extension runs for real, real
 * service worker, real content scripts injected by `chrome.scripting`, real
 * panel document, and only the network is intercepted, at the transport layer.
 * So the content script genuinely fetches, genuinely parses, and the panel
 * genuinely renders.
 *
 * Two details make this deterministic rather than flaky:
 *
 *   - The extension id is computed from the extension's absolute path, so a
 *     test never waits for the worker to appear before it can navigate. That
 *     matters because an MV3 worker is lazy: it does not start until something
 *     wakes it, so waiting for it first would deadlock.
 *   - YouTube is served from fixtures, so there is no network, no video, and no
 *     dependence on what the site happens to serve today.
 *
 * These tests are slow, so they are opt-in. See TESTING.md.
 */

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { json3Body, xmlBody, watchPage } from './fixtures.mjs';
// Shared with tools/capture.mjs rather than copied, so the capture tool and the
// tests cannot end up using different browsers as the path list ages.
export { findChrome } from '../../tools/lib/chrome.mjs';
import { findChrome } from '../../tools/lib/chrome.mjs';

export const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const YOUTUBE_WATCH = 'https://www.youtube.com/watch**';

/**
 * Chrome derives an unpacked extension's id from its absolute path: the first
 * 16 bytes of the SHA-256, each hex nibble mapped to a letter a–p.
 *
 * @param {string} path
 * @returns {string}
 */
export function extensionIdForPath(path) {
  const hash = createHash('sha256').update(path).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

/** Thrown when no usable browser is present, so a caller can skip rather than fail. */
export class BrowserUnavailable extends Error {}

/**
 * Launch Chromium with the extension loaded.
 *
 * @returns {Promise<{context: object, extensionId: string, close: () => Promise<void>}>}
 */
export async function launchExtension() {
  const executablePath = findChrome();
  if (!executablePath) {
    throw new BrowserUnavailable(
      'No Chromium able to load extensions was found. Set CHROME_PATH, or skip the browser tests.',
    );
  }

  const context = await chromium.launchPersistentContext('', {
    executablePath,
    // The bundled headless shell cannot load extensions, but this flag makes
    // full Chromium run without a display, which is what lets this work in a
    // container and in WSL.
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  return {
    context,
    extensionId: extensionIdForPath(EXTENSION_ROOT),
    close: () => context.close(),
  };
}

/**
 * Serve a fake YouTube, so a test never touches the network.
 *
 * Safe to call repeatedly for different videos, and a test that covers more than
 * one video must call it more than once, do NOT instead call it twice and hope.
 * Playwright matches routes last-registered-first, so two competing `watch**`
 * handlers would silently serve whichever was registered most recently for every
 * video. Instead the routes are installed once and dispatch on the `?v=`
 * parameter against a registry of the videos a test has declared.
 *
 * Also records every URL the extension requested, which is how a test asserts
 * that something was *fetched* rather than merely rendered.
 *
 * @param {object} context
 * @param {object} options
 * @param {string} [options.videoId]
 * @param {string} [options.title]
 * @param {Array<object>} options.tracks
 * @param {'json3'|'xml'} [options.captionFormat]
 * @param {boolean} [options.breakBaseUrl] Refuse the direct track URL, to force
 *   the INERTUBE fallback for this video.
 * @returns {Promise<{captionRequests: string[], playerRequests: string[], blockedRequests: string[]}>}
 */
export async function routeYouTube(context, { videoId = 'dQw4w9WgXcQ', title = 'Fixture Video', tracks, captionFormat = 'json3', breakBaseUrl = false, capture = null, trustedTypes = false }) {
  /** Shared across every call for this browser, so one set of routes serves all. */
  const registry = (context.__iuFixture ??= {
    videos: new Map(),
    captionRequests: [],
    playerRequests: [],
    // Every request that matched no handler and was refused. Read by a test to
    // assert the tier really is offline, rather than assuming it from the route
    // list, which is what let an unrouted path have gone to the network before.
    blockedRequests: [],
    // Whether the watch page carries YouTube's real Trusted Types policy.
    trustedTypes: false,
    installed: false,
  });

  // Sticky once set: the routes are installed once and read this per request, so
  // a later call without the flag must not silently drop the policy.
  if (trustedTypes) registry.trustedTypes = true;

  // A capture carries the real track list, the real segments and, importantly,
  // the real `translationLanguages`, none of which a hand-written fixture can be
  // trusted about. Hand-written tracks remain for the cases that need a specific
  // shape, and both go down the same route handlers.
  if (capture) {
    registry.videos.set(capture.videoId, {
      title: capture.title,
      tracks: capture.tracks,
      translationLanguages: capture.translationLanguages,
      captionFormat,
      breakBaseUrl,
    });
    if (!registry.installed) {
      registry.installed = true;
      await installRoutes(context, registry);
    }
    return {
      captionRequests: registry.captionRequests,
      playerRequests: registry.playerRequests,
      blockedRequests: registry.blockedRequests,
    };
  }

  registry.videos.set(videoId, { title, tracks, captionFormat, breakBaseUrl });

  if (!registry.installed) {
    registry.installed = true;
    await installRoutes(context, registry);
  }

  return {
    captionRequests: registry.captionRequests,
    playerRequests: registry.playerRequests,
    blockedRequests: registry.blockedRequests,
  };
}

/**
 * The Content Security Policy YouTube actually serves on a watch page.
 *
 * Verified the hard way: a capture died on `DOMParser.parseFromString` with
 * "This document requires 'TrustedHTML' assignment", which is that policy and
 * nothing else. Reproduced locally in `tools/probe-trusted-types.mjs`, a page
 * serving this header throws the identical error, and a blank page does not.
 *
 * It matters here because the tier is supposed to replay the real CONDITIONS, not
 * only the real bytes. Serving the captured page without its policy would exercise
 * a page that differs from YouTube's in exactly the way that cost a capture.
 */
export const TRUSTED_TYPES_CSP = "require-trusted-types-for 'script'";

/**
 * Install the route handlers once.
 *
 * @param {object} context
 * @param {object} registry
 */
async function installRoutes(context, registry) {
  /** The video a URL refers to. @param {string} url */
  const videoFor = (url) => registry.videos.get(new URL(url).searchParams.get('v'));

  // FAIL CLOSED, and do it FIRST.
  //
  // Playwright tries the most recently registered route first, so this is only
  // consulted when none of the specific handlers below matched. Without it, any
  // request we did not anticipate, a consent redirect, a subdomain, an analytics
  // call, a path we simply did not know about, goes to the REAL internet. The
  // suite would still look hermetic, because the tests would pass either way, and
  // "offline" would be a property of my memory rather than of the browser.
  //
  // SCOPED to http(s), which is not a detail: a bare `'**'` pattern also matches
  // `chrome-extension://`, so it aborted the extension's own script and document
  // loads and every test failed to render anything. The guard is meant to stop
  // network traffic, not to cut off the extension under test.
  await context.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    (route) => {
      registry.blockedRequests.push(route.request().url());
      return route.abort();
    },
  );

  await context.route(YOUTUBE_WATCH, async (route) => {
    const url = route.request().url();
    const fixture = videoFor(url) ?? [...registry.videos.values()][0];

    // Unknown video: a bare page with no player response, so a test can rely on
    // it not being confused for one of the declared fixtures.
    if (!fixture) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Unknown</title>' });
    }

    const videoId = new URL(url).searchParams.get('v');
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      // The policy only when a test asked for it, so ordinary cases stay simple
      // and the ones that care are explicit about it.
      headers: registry.trustedTypes ? { 'Content-Security-Policy': TRUSTED_TYPES_CSP } : undefined,
      body: watchPage({
        videoId,
        title: fixture.title,
        tracks: fixture.tracks,
        translationLanguages: fixture.translationLanguages,
      }),
    });
  });

  await context.route('https://www.youtube.com/', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>YouTube</title>' });
  });

  await context.route('https://www.youtube.com/youtubei/v1/player**', async (route) => {
    const body = route.request().postData() ?? '{}';
    registry.playerRequests.push(route.request().url());

    const videoId = JSON.parse(body)?.videoId;
    const fixture = registry.videos.get(videoId) ?? [...registry.videos.values()][0];

    // The fallback re-asks for the track list, then fetches the baseUrl it hands
    // back. Answering with the same tracks is what makes it reachable.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: (fixture?.tracks ?? []).map((track) => ({
              baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${track.languageCode}&fresh=1`,
              languageCode: track.languageCode,
              name: { simpleText: track.name },
              kind: track.kind ?? undefined,
            })),
          },
        },
      }),
    });
  });

  await context.route('https://www.youtube.com/api/timedtext**', async (route) => {
    const url = route.request().url();
    const params = new URL(url).searchParams;
    registry.captionRequests.push(url);

    const fixture = registry.videos.get(params.get('v')) ?? [...registry.videos.values()][0];

    // Forces the fallback path: the first, direct attempt is refused.
    if (fixture?.breakBaseUrl && !params.has('fresh')) {
      return route.fulfill({ status: 403, body: '' });
    }

    const track = fixture?.tracks.find((t) => t.languageCode === params.get('lang')) ?? fixture?.tracks[0];
    if (!track) return route.fulfill({ status: 404, body: '' });

    // Auto-translate is not a separate track: YouTube serves the SAME track with
    // `tlang` added and re-renders the text. The fixture has to do the same, or
    // the picker would appear to work while returning the original language,
    // and the browser tier is the only place the real URL is built.
    const translateTo = params.get('tlang');
    const segments = translateTo
      ? track.segments.map((segment) => ({ ...segment, text: `[${translateTo}] ${segment.text}` }))
      : track.segments;

    const body = fixture.captionFormat === 'xml' ? xmlBody(segments) : json3Body(segments);
    return route.fulfill({ status: 200, contentType: 'text/plain', body });
  });
}

/**
 * Open a fixture YouTube watch page.
 *
 * @param {object} context
 * @param {string} [videoId]
 * @returns {Promise<object>}
 */
export async function openWatchPage(context, videoId = 'dQw4w9WgXcQ') {
  const page = await context.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded' });
  return page;
}

/**
 * Open the side panel as a document, beside a watch page.
 *
 * A real panel is not a tab. It is loaded here as one because that is the only
 * way to drive it, and the panel document behaves identically, same origin,
 * same permissions, same service worker.
 *
 * One difference matters and is easy to get wrong: opening the panel makes it
 * the ACTIVE tab, whereas a real side panel never is. Since the worker resolves
 * the video from the active tab, the watch page has to be brought back to the
 * front afterwards, or the worker will look at the panel's own tab and correctly
 * conclude there is no video in it. Doing so also exercises the real path, where
 * switching to the video tab is what tells the worker which video to show.
 *
 * @param {object} context
 * @param {string} extensionId
 * @param {object} watchPage The page to sit beside; brought to the front.
 * @returns {Promise<{page: object, errors: string[]}>}
 */
export async function openPanel(context, extensionId, watchPage = null) {
  const page = await context.newPage();
  const errors = [];

  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`, { waitUntil: 'domcontentloaded' });

  // Hand focus back to the video, as it would be in real use.
  if (watchPage) await watchPage.bringToFront();

  return { page, errors };
}

/**
 * Wait until the panel stops showing its startup placeholder.
 *
 * Note this can return on an error status: the panel reports "no video in the
 * active tab" long before it finishes retrying. Tests that expect a transcript
 * should wait with `waitForRows` instead, or they will assert against a panel
 * that has not got there yet.
 *
 * @param {object} page
 * @param {number} [timeout]
 * @returns {Promise<string>}
 */
export async function waitForStatus(page, timeout = 20000) {
  await page.waitForFunction(
    () => {
      const text = document.getElementById('status')?.textContent ?? '';
      return text.length > 0 && !text.includes('Looking for');
    },
    { timeout },
  );
  return page.textContent('#status');
}

/**
 * Wait until the panel has rendered transcript lines.
 *
 * ⚠️ A ROW COUNT ALONE IS NOT THE CONDITION, and waiting on it is how this helper
 * produced a flaky test. The panel keeps showing the previous video's rows until
 * the new video's transcript arrives, so `waitForRows(page, 2)` returns
 * IMMEDIATELY when a previous section left three rows on screen, and the test
 * then asserts against the old video's text. It passed most of the time only
 * because the rebuild usually won the race.
 *
 * So when the section before yours could leave rows behind, pass `text` and wait
 * for the content you are about to assert on. The count still has to hold; the
 * text is what makes the wait mean "the panel is showing THIS video".
 *
 * @param {object} page
 * @param {number} [count] Minimum rows, defaults to one.
 * @param {{timeout?: number, text?: string|null}} [options]
 *   `text` waits for a row whose primary line contains it.
 * @returns {Promise<number>}
 */
export async function waitForRows(page, count = 1, { timeout = 20000, text = null } = {}) {
  await page.waitForFunction(
    ({ expected, wanted }) => {
      const rows = [...document.querySelectorAll('.row')];
      if (rows.length < expected) return false;
      if (!wanted) return true;
      return rows.some((row) => {
        const primary = row.querySelector('.primary');
        if (!primary) return false;
        // Ruby annotation removed before matching. The reading sits inside the
        // line's element, so a substring test against `textContent` sees
        // `wǒmen我们…` and never matches `我们`, which made this wait time out
        // with the transcript visibly correct on screen.
        const clone = primary.cloneNode(true);
        for (const annotation of clone.querySelectorAll('rt')) annotation.remove();
        return (clone.textContent ?? '').includes(wanted);
      });
    },
    { expected: count, wanted: text },
    { timeout },
  );
  return page.locator('.row').count();
}

/**
 * Everything the panel is currently showing.
 *
 * @param {object} page
 * @returns {Promise<object>}
 */
export async function panelState(page) {
  return page.evaluate(() => ({
    status: document.getElementById('status')?.textContent ?? '',
    isError: document.getElementById('status')?.classList.contains('error') ?? false,
    rows: [...document.querySelectorAll('.row')].map((row) => ({
      time: row.querySelector('.time')?.textContent ?? '',
      // Ruby annotation removed, as everywhere else that reads a line's text,
      // see `baseText`. `textContent` includes the reading, so any assertion
      // against this would see `wǒmen我们…`.
      text: (() => {
        const primary = row.querySelector('.primary');
        if (!primary) return '';
        const clone = primary.cloneNode(true);
        for (const annotation of clone.querySelectorAll('rt')) annotation.remove();
        return clone.textContent ?? '';
      })(),
      secondary: row.querySelector('.secondary')?.textContent ?? '',
      active: row.classList.contains('active'),
    })),
    options: [...(document.getElementById('study')?.options ?? [])].map((option) => option.value),
    glossOptions: [...(document.getElementById('gloss')?.options ?? [])].map((option) => option.value),
    study: document.getElementById('study')?.value ?? '',
    gloss: document.getElementById('gloss')?.value ?? '',
  }));
}

/**
 * Where the page video was last told to go.
 *
 * @param {object} page
 * @returns {Promise<number|null>}
 */
export async function pagePosition(page) {
  return page.evaluate(() => window.__position?.() ?? null);
}

/**
 * A row's line text with any ruby annotation removed.
 *
 * **Pass to `page.evaluate(baseText, selector)`**, not `page.evaluate(baseText(sel))`.
 * The distinction is the whole reason this is written the way it is: a function
 * closed over its argument cannot be serialised into the page, so
 * `page.evaluate(closure)` throws `selector is not defined` and looks like a
 * problem with the page rather than with how it was called. Taking the selector as
 * an ARGUMENT is what makes the function self-contained and serialisable.
 *
 * **Why not `textContent` directly.** The panel can draw a reading over each word,
 * 拼音 or Rōmaji, and the annotation lives inside the line's element, correctly,
 * because `<rt>` belongs beside its base text. `textContent` therefore returns
 * `wǒmen我们zài在…`, so an assertion comparing the line to what was said fails while
 * the panel is perfectly right. That is not hypothetical: it broke the moment
 * readings defaulted on.
 *
 * Dropping `<rt>` is the platform's own rule for ruby, it is what a screen reader
 * skips and what a copy of the rendered text produces.
 *
 * Exports are unaffected either way: copy and save read the panel's row data, not
 * the DOM.
 *
 * @param {string} selector
 * @returns {string}
 */
export const baseText = (selector) => {
  const element = document.querySelector(selector);
  if (!element) return '';
  const clone = element.cloneNode(true);
  for (const annotation of clone.querySelectorAll('rt')) annotation.remove();
  return clone.textContent ?? '';
};

/**
 * Whether an element's text, minus ruby annotation, equals an expected string.
 *
 * A separate function for `page.waitForFunction`, which needs a PREDICATE rather
 * than a value, and which takes its argument the same way, so this stays
 * serialisable for the same reason.
 *
 * @param {{selector: string, expected: string}} args
 * @returns {boolean}
 */
export const baseTextIs = ({ selector, expected }) => {
  const element = document.querySelector(selector);
  if (!element) return false;
  const clone = element.cloneNode(true);
  for (const annotation of clone.querySelectorAll('rt')) annotation.remove();
  return (clone.textContent ?? '') === expected;
};
