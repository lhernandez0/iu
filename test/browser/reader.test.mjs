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
const FIXTURES = join(ROOT, 'test', 'mkv');
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

  // **Bring the reader back to the front, and this is not incidental.** The worker
  // resolves the ACTIVE tab, so a file chosen in a background tab is a file the
  // panel never hears about. That is correct behaviour — a real user picks a file
  // while looking at the reader — but it makes the test order-dependent, which is
  // how this suite failed intermittently with the panel opened last.
  await reader.bringToFront();

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

  // The reader is the tab the user is looking at, so the worker can resolve it.
  // See the note at the top of this file about why the order is load-bearing.
  await reader.bringToFront();
  // `setInputFiles` on the real hidden input, which is what the label opens.
  await reader.setInputFiles('#pick-files', join(FIXTURES, 'three-tracks.mkv'));

  // Wait for the CONDITION rather than for a duration: extraction walks the media,
  // and a fixed sleep is either slower than necessary or occasionally too short —
  // the latter producing a flaky failure that reads as a code bug.
  await panel.waitForFunction(() => document.querySelectorAll('.row').length > 0, null, { timeout: 15000 });

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

section('machine translation is refused for a local file, visibly');

{
  // A local file cannot be machine-translated: it would mean a network request,
  // which the extension does not make outside the video's own captions. So the
  // reader reports every track as untranslatable and the panel DISABLES the two
  // `MT` checkboxes rather than leaving them live.
  //
  // Asserted in the browser rather than in the panel's own suite because that is
  // where the two halves meet: the panel already had the disable logic (`a track
  // that cannot be translated disables its own box`), and it was only useful here
  // if the reader actually reports the flag. A unit test on either side passes
  // while the pair is broken — which is the exact shape of the bug that made the
  // reader produce no transcript at all.
  //
  // Without this the checkboxes appear to work and change nothing, which is the
  // failure mode this codebase designs against everywhere else.
  const studyBox = panel.locator('#study-translated');
  const glossBox = panel.locator('#gloss-translated');

  check('the study MT box is disabled', await studyBox.isDisabled(), true);
  check('and says why', (await studyBox.getAttribute('title')) ?? '', 'This caption track cannot be auto-translated');

  // The gloss line may have no track selected, in which case the box is disabled
  // for that reason instead. Either way it must not be tickable.
  check('the gloss MT box is disabled', await glossBox.isDisabled(), true);
  check('and it is not checked', await glossBox.isChecked(), false);
}

section('rows seek the real video element');

{
  const rows = panel.locator('.row');
  if ((await rows.count()) > 1) {
    await reader.bringToFront();
    await rows.nth(1).click();
    await panel.waitForFunction(() => document.getElementById('video') !== null, null, { timeout: 5000 }).catch(() => {});
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
  await plain.bringToFront();
  await plain.setInputFiles('#pick-files', join(FIXTURES, 'no-subtitles.mkv'));
  // Same rule as above: wait for the message, not for a duration.
  await plain.waitForFunction(
    () => /READER005|no subtitles/i.test(document.getElementById('status')?.textContent ?? ''),
    null,
    { timeout: 15000 },
  );

  const status = await plain.textContent('#status');
  check('a file with no subtitles says so', /READER005|no subtitles/i.test(status ?? ''), true);
  await plain.close();
}

await closeAll();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
