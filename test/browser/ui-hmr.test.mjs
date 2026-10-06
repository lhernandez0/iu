/**
 * Verifies the one thing Vite was adopted for: a stylesheet edit reaching the
 * browser WITHOUT a reload.
 *
 * This is not a restatement of the smoke test. The smoke test proves the panel
 * renders; this proves the iteration loop actually works, because that loop is the
 * entire reason for using a dev server instead of a static file server. If HMR
 * silently degraded to a full reload, every test would still pass and the tool
 * would have lost the property it was chosen for.
 *
 * Development tooling only. Offline: localhost, local files.
 */

import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.IU_UI_PORT ?? 8098);
const SHEET = join(ROOT, 'src/sidepanel/sidepanel.css');

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

const ready = Date.now() + 30_000;
let up = false;
while (Date.now() < ready && !up) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/tools/ui/`);
    if (response.ok) up = true;
  } catch {
    // not yet
  }
  if (!up) await new Promise((done) => setTimeout(done, 150));
}

let browser;
// The original bytes, restored in `finally`. A test that leaves the stylesheet
// modified is worse than one that fails.
const original = await readFile(SHEET, 'utf8');

try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  // Distinguishes a hot CSS swap from a page reload. A reload resets this; a
  // hot update does not, which is exactly the distinction being tested.
  await page.goto(`http://127.0.0.1:${PORT}/tools/ui/?scenario=bilingual`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('.row').length > 0, null, { timeout: 10000 });
  await page.evaluate(() => {
    window.__notReloaded = true;
  });

  const before = await page.evaluate(() => getComputedStyle(document.querySelector('.row')).borderRadius);
  const marker = '17px';

  // Append a rule that is trivially detectable, save, and see it arrive.
  await appendFile(SHEET, `\n.preview-hmr-probe { border-radius: ${marker}; }\n`);

  await page.waitForFunction(
    (expected) => {
      const el = document.querySelector('.row');
      if (!el) return false;
      el.classList.add('preview-hmr-probe');
      const applied = getComputedStyle(el).borderRadius;
      el.classList.remove('preview-hmr-probe');
      return applied === expected;
    },
    marker,
    { timeout: 15000 },
  );

  const after = await page.evaluate(() => {
    const el = document.querySelector('.row');
    el.classList.add('preview-hmr-probe');
    const applied = getComputedStyle(el).borderRadius;
    el.classList.remove('preview-hmr-probe');
    return applied;
  });

  check('the stylesheet edit reached the browser', after, marker);
  check('the style actually changed', after !== before, true);
  // The point: no reload. A dev server that reloads on every CSS save would still
  // pass the two checks above.
  check('and it did NOT reload the page', await page.evaluate(() => window.__notReloaded), true);
  check('so the mock worker kept its state', await page.evaluate(() => document.querySelectorAll('.row').length > 0), true);

  // The summary format the tier runner parses, so this suite reports a count
  // like the others rather than a dash.
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (!failures) console.log('HMR works: a stylesheet edit lands without a reload.');
} catch (error) {
  console.log(`\n  FAIL  ${error?.message ?? error}`);
  failures++;
} finally {
  await writeFile(SHEET, original);
  await browser?.close();
  child.kill('SIGKILL');
}

process.exit(failures ? 1 : 0);
