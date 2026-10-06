/**
 * Smoke test for the preview server (`npm run ui`).
 *
 * The preview exists so layout can be iterated on without loading a YouTube
 * video, which means nothing else exercises it. That is exactly the kind of tool
 * that rots: a control renamed in `sidepanel.html` and not in the preview's copy
 * of the markup shows up as a blank page, and nobody notices until they next want
 * to use it.
 *
 * So this boots the real dev server, loads the real panel in a real browser, and
 * asserts what would otherwise fail silently:
 *
 *   1. Every module the panel imports is served — a 404 is a blank page.
 *   2. The panel reached its rendered state (rows on screen), so the mock worker
 *      and the panel agree about the protocol.
 *   3. The scenario's distinctive feature is actually on screen: a gloss for the
 *      translated case, no marks when nothing is marked, and so on.
 *   4. No console error or page error was raised.
 *
 * It does NOT assert what anything looks like. This is a development tool, and
 * the point of the preview is that a person looks at it.
 *
 * Offline: it serves local files and opens a localhost page. It never reaches
 * youtube.com.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';
import { SCENARIOS } from '../../tools/ui/scenarios.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.IU_UI_PORT ?? 8099);

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
  console.log('SKIP  no Chromium found; cannot smoke-test the preview server.');
  process.exit(0);
}

/**
 * Start Vite and wait for it to answer.
 *
 * Polled rather than slept, so a slow machine does not produce a spurious failure
 * and a fast one does not waste a second. Vite is ready when its HTML answers.
 *
 * @returns {Promise<{stop: Function}>}
 */
async function startServer() {
  const child = spawn(
    'npx',
    ['vite', '--config', 'tools/ui/vite.config.mjs', '--port', String(PORT)],
    {
      cwd: ROOT,
      env: { ...process.env, IU_UI_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));

  const ready = Date.now() + 30_000;
  while (Date.now() < ready) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/tools/ui/`);
      if (response.ok) {
        await response.text();
        return { stop: () => child.kill('SIGKILL') };
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 150));
  }

  child.kill('SIGKILL');
  throw new Error(`the preview server did not start:\n${log}`);
}

const server = await startServer();
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let exitCode = 0;
try {
  for (const scenario of SCENARIOS) {
    console.log(`\n${scenario.id} — ${scenario.label}`);

    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    // Capture the response status of everything the page loads, so a module that
    // 404s is reported as itself rather than as a mysterious blank panel.
    const failed = [];
    page.on('response', (response) => {
      if (response.status() >= 400) failed.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });

    await page.goto(`http://127.0.0.1:${PORT}/tools/ui/?scenario=${scenario.id}`, { waitUntil: 'load' });

    // The panel renders from the first STATE push, which the mock sends on start.
    //
    // A timeout here is the most likely failure — the page loaded but the panel
    // never rendered — and the reason is almost always in the console. So the
    // wait is caught rather than thrown: the console errors collected above are
    // the actual report, and a bare "Timeout 5000ms exceeded" would hide them.
    let renderedByPanel = true;
    try {
      await page.waitForFunction(
        () => !document.getElementById('status')?.textContent?.includes('Looking for'),
        null,
        { timeout: 5000 },
      );
    } catch {
      renderedByPanel = false;
    }

    check('the panel reached its rendered state', renderedByPanel, true);
    check('no request failed', failed, []);
    check('no console or page error', errors, []);
    if (!renderedByPanel) {
      // Everything needed to diagnose it, in the output, rather than a timeout.
      console.log(`          status still: ${JSON.stringify(await page.textContent('#status'))}`);
      await context.close();
      continue;
    }

    // What the panel SHOWS, read from the DOM the panel actually produced.
    const rendered = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.row')];
      return {
        rows: rows.length,
        first: rows[0]?.querySelector('.primary')?.textContent ?? '',
        gloss: rows[0]?.querySelector('.secondary')?.textContent ?? '',
        marks: document.querySelectorAll('.mark').length,
        glossOptionsHidden: document.getElementById('gloss-options')?.hidden ?? null,
        status: (document.getElementById('status')?.textContent ?? '').slice(0, 40),
      };
    });

    if (scenario.error) {
      check('the error is shown', rendered.status.includes('No YouTube tab'), true);
      check('with no rows', rendered.rows, 0);
    } else if (!scenario.tracks.length) {
      check('no captions is reported', rendered.status.includes('No transcript'), true);
    } else {
      check('the transcript rendered', rendered.rows > 0, true);
      check('with text on the first line', rendered.first.length > 0, true);
      check('the status has left its placeholder', rendered.status.includes('lines'), true);
    }

    // The translation controls are only offered when there is a line to translate.
    if (scenario.tracks.length) {
      check('the gloss controls follow the scenario', rendered.glossOptionsHidden, !scenario.settings.glossLanguage);
    }

    // Each scenario exists to make one state reachable, so what matters is that
    // the state is actually on screen. A preview that rendered every scenario
    // identically would pass every check above.
    if (scenario.id === 'bilingual') {
      check('the gloss line has text', rendered.gloss.length > 0, true);
      check('and the two lines differ', rendered.gloss !== rendered.first, true);
      check('with words marked', rendered.marks > 0, true);
    }
    if (scenario.id === 'same-language') {
      // One language on both lines, the second machine translated — the reported
      // case, and the one that used to render the translation on both lines.
      check('the gloss is the translated rendering', rendered.gloss.startsWith('[zh-Hans]'), true);
      check('and the study line is not translated', rendered.first.startsWith('[zh-Hans]'), false);
    }
    if (scenario.id === 'study-only') {
      check('there is no gloss line at all', rendered.gloss, '');
    }
    if (scenario.id === 'no-marks') {
      check('nothing is marked', rendered.marks, 0);
      check('but the text is still there', rendered.first.length > 0, true);
    }

    await context.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
} catch (error) {
  console.log(`\n  FAIL  ${error?.message ?? error}`);
  failures++;
  exitCode = 1;
} finally {
  await browser.close();
  server.stop();
}

if (failures) {
  console.log(`\n  ${failures} check(s) failed.`);
  exitCode = 1;
}
process.exit(exitCode);
