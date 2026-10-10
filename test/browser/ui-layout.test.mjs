/**
 * Proves the Collapsed layout is reversible, in a real browser with real CSS.
 *
 * The bug this exists for: the toggle was a `<select>` inside the reading bar, and
 * the reading bar is exactly what `collapsed` hides. Collapsing therefore removed
 * the only control that could undo it, and the panel was stuck, the one property
 * a toggle must have, and it was missing.
 *
 * A hermetic test cannot catch that. It can assert the button reports the right
 * state, but whether the element is VISIBLE after the stylesheet runs is a
 * question about layout, and layout needs a browser. `display: none` on an
 * ancestor is invisible to `document.getElementById`.
 *
 * Offline: loads the panel's dev preview over localhost.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.IU_UI_PORT ?? 8096);

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

const executablePath = findChrome();
if (!executablePath) {
  console.log('SKIP  no Chromium found.');
  process.exit(0);
}

const child = spawn('npx', ['vite', '--config', 'tools/ui/vite.config.mjs', '--port', String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, IU_UI_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const deadline = Date.now() + 30_000;
let up = false;
while (Date.now() < deadline && !up) {
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/tools/ui/`)).ok;
  } catch {
    // not yet
  }
  if (!up) await new Promise((done) => setTimeout(done, 150));
}

let browser;
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/tools/ui/`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('.row').length > 0, null, { timeout: 20000 });

  /**
   * Whether the element is actually on screen, not merely in the DOM.
   *
   * `offsetParent` is null for a element hidden by `display: none` on itself or an
   * ancestor, which is exactly the case being tested. A `getElementById` check
   * would pass while the control was invisible.
   */
  const visible = (id) =>
    page.evaluate((elementId) => {
      const element = document.getElementById(elementId);
      return Boolean(element && element.offsetParent !== null);
    }, id);

  check('the reading bar starts visible', await visible('view-mode'), true);
  check('and so does the toggle', await visible('layout'), true);

  await page.click('#layout');
  await page.waitForFunction(() => document.body.classList.contains('collapsed'), null, { timeout: 5000 });

  check('collapsing hides the reading bar', await visible('view-mode'), false);
  // The whole point. If this is false the panel is stuck with no way back.
  check('but the toggle is still visible', await visible('layout'), true);
  check('and the transcript is still there', await visible('transcript'), true);

  // And it goes back, which is the property that was missing.
  await page.click('#layout');
  await page.waitForFunction(() => !document.body.classList.contains('collapsed'), null, { timeout: 5000 });
  check('clicking it again brings the reading bar back', await visible('view-mode'), true);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) console.log('\nThe Collapsed layout is not reversible.');
} catch (error) {
  console.log(`\n  FAIL  ${error?.message ?? error}`);
  failures++;
} finally {
  await browser?.close();
  child.kill('SIGKILL');
}

process.exit(failures ? 1 : 0);
