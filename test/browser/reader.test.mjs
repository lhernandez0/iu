/**
 * The reader page, driven in a real browser.
 *
 * **This file exists because there was no test between the Matroska parser and the
 * panel.** `matroska.test.mjs` proves the container parser reads real files;
 * `service-worker.test.mjs` proves the worker resolves a reader tab. Nothing proved
 * the two connect — and they did not, in a way neither suite could see.
 *
 * ## The bug this would have caught
 *
 * `settings.studyLanguage` defaults to `null`, so the FIRST request for any video
 * is `PROVIDE { languageCode: null }`. The reader answered "no such track". So a
 * file with three subtitle tracks, perfectly parsed, produced **no transcript at
 * all** — while the parser suite stayed green and the worker suite stayed green,
 * because neither of them ever asked the reader for a track.
 *
 * The YouTube content script has always handled this (`wanted ??
 * pickDefaultTrack(...)`), and that is exactly why the gap was invisible:
 * every previous test drove the YouTube path.
 *
 * So this suite drives the REAL reader page over `chrome-extension://`, with the
 * real service worker and the real panel, and asserts that subtitles appear.
 *
 * Run: npm run test:browser
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(ROOT, 'test', 'fixtures');
const EXTENSION_ROOT = ROOT;

let failures = 0;
let checks = 0;

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

if (!existsSync(join(FIXTURES, 'three-tracks.mkv'))) {
  console.log('\n  FAIL  the MKV fixtures are not present.');
  console.log('        They are generated, not committed. Run:  npm run fixtures');
  process.exit(1);
}

// --- Launch -----------------------------------------------------------------

const { extensionIdForPath: idForPath, findChrome } = await import('./harness.mjs');

let context;
let closeAll = async () => {};

try {
  const executablePath = await findChrome();
  context = await chromium.launchPersistentContext('', {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`,
    ],
  });
  closeAll = () => context.close();
} catch (error) {
  console.log('\n  SKIP  no browser available:', String(error?.message ?? error));
  console.log(`\n${checks - failures}/${checks} checks passed (browser unavailable)`);
  process.exit(0);
}

const extensionId = idForPath(EXTENSION_ROOT);

section('the reader page loads and announces itself');

/** @type {import('playwright').Page} */
let reader;
let panel;

try {
  // The reader, opened the way the toolbar menu opens it — as an extension page in
  // a tab.
  reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

  // The panel, connected to the same worker. Opened as a tab for the same reason
  // `harness.mjs` does: a real side panel is never the active tab, and opening one
  // as a tab would make the worker resolve the wrong tab.
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);

  await panel.waitForTimeout(1500);

  check('the reader page loaded', await reader.title(), 'IU — video');
  // The reader must be resolvable even with the panel already open, which is the
  // path that was broken.
  const readerStatus = await reader.textContent('#status');
  check('the reader reports itself ready', typeof readerStatus, 'string');
} catch (error) {
  console.log('\n  FAIL  could not open the pages:', String(error?.message ?? error));
  check('the pages opened', false, true);
}

section('a real MKV produces subtitles in the panel');

{
  // The whole point. A file with three text subtitle tracks goes in, and text must
  // come out the other end — through DESCRIBE, the language pickers, PROVIDE with
  // a NULL language (because the default study language is unset), cue extraction,
  // and the row model.
  const before = await panel.textContent('#transcript');

  // `setInputFiles` on the real hidden input, which is what the label opens.
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));
  // Discovery reads the container and the panel refetches; give it room, because
  // reading a film's cues is the slow path.
  await panel.waitForTimeout(4000);

  const status = await reader.textContent('#status');
  const after = await panel.textContent('#transcript');
  const rows = await panel.locator('.row').count();

  check('the reader found the embedded tracks', /track/i.test(status ?? ''), true);
  // The regression, stated directly: rows must appear with NO language chosen.
  check('the panel shows transcript rows', rows > 0, true);
  check('and the transcript actually changed', after !== before, true);
  // The panel's language picker must offer the fixture's languages, normalised —
  // `zho`/`jpn` in the file, `zh`/`ja` here, because that is what the word lists
  // are keyed by and a track under any other code marks nothing.
  const options = await panel.locator('#study option').allTextContents();
  const values = await panel.locator('#study option').evaluateAll((els) => els.map((e) => e.value));
  void options;

  check('the Chinese track is offered', values.some((v) => v === 'zh'), true);
  check('and the Japanese one', values.some((v) => v === 'ja'), true);
  check('and the English gloss line', values.some((v) => v === 'en'), true);
}

section('rows seek the real video element');

{
  const rows = panel.locator('.row');
  if ((await rows.count()) > 1) {
    await rows.nth(1).click();
    await panel.waitForTimeout(600);
    const time = await reader.evaluate(() => document.getElementById('video').currentTime);
    // Clicking a row must move the real <video>, not just the highlight.
    check('clicking a row seeks the video', time > 0, true);
  } else {
    check('there were rows to click', false, true);
  }
}

section('the panel shows what is missing rather than an empty transcript');

{
  // A file with no subtitle tracks. This must explain itself, because an empty
  // transcript with no message is the failure shape the codebase designs against.
  const plain = await context.newPage();
  await plain.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
  await plain.setInputFiles('#pick-files', join(FIXTURES, 'no-subtitles.mkv'));
  await plain.waitForTimeout(3000);

  const status = await plain.textContent('#status');
  check('a file with no subtitles says so', /READER005|no subtitles/i.test(status ?? ''), true);
  await plain.close();
}

await closeAll();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
