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
import { readFile } from 'node:fs/promises';
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
 * The preview page duplicates the panel's markup, and that duplication has a cost
 * that was paid for real: `layout` was added here and not to `sidepanel.html`, so
 * the preview worked while the SHIPPING panel threw on the missing element and
 * rendered nothing. The browser tier caught it; nothing in the preview did.
 *
 * So the two files are compared directly. Any id the panel reaches for must exist
 * in both, and this runs before a browser is even launched.
 *
 * @param {string} html
 * @returns {Set<string>}
 */
function declaredIds(html) {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
}

{
  const panelHtml = await readFile(join(ROOT, 'src/sidepanel/sidepanel.html'), 'utf8');
  const previewHtml = await readFile(join(ROOT, 'tools/ui/index.html'), 'utf8');
  const panel = declaredIds(panelHtml);
  const preview = declaredIds(previewHtml);

  const onlyPanel = [...panel].filter((id) => !preview.has(id));
  // Preview-only ids are expected: the switcher and the note are the shell around
  // the panel and have no counterpart in the shipped markup. What matters is the
  // other direction — the panel needing something the preview does not declare.
  const onlyPreview = [...preview].filter((id) => !panel.has(id) && !id.startsWith('preview-'));

  check('the preview declares no panel id that the panel does not', onlyPreview, []);
  check('and the panel declares no id the preview does not', onlyPanel, []);
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
        // The reading is <ruby>/<rt> INSIDE the line element, so raw
        // `textContent` interleaves it (`wǒmen我们…`). Strip it: every
        // assertion below is about what the line SAYS, not how it is annotated.
        first: (() => {
          const primary = rows[0]?.querySelector('.primary');
          if (!primary) return '';
          const clone = primary.cloneNode(true);
          for (const annotation of clone.querySelectorAll('rt')) annotation.remove();
          return clone.textContent ?? '';
        })(),
        gloss: rows[0]?.querySelector('.secondary')?.textContent ?? '',
        marks: document.querySelectorAll('.mark').length,
        targetHidden: document.getElementById('translate-target-row')?.hidden ?? null,
        mtBoxes: [...document.querySelectorAll('.line-translate input')].map((input) => input.id),
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

    // The target control follows whether anything has asked to be translated,
    // rather than whether a second line exists: either line can be translated now,
    // so a single-line video still gets the control.
    const wantsTarget = Boolean(scenario.settings.glossTranslated || scenario.settings.studyTranslated);
    check('the translate target follows the scenario', rendered.targetHidden, !wantsTarget);
    // Both lines always offer their own MT checkbox, disabled where the track
    // cannot take a translation.
    check('both lines have a translate checkbox', rendered.mtBoxes, ['study-translated', 'gloss-translated']);

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
      // The point of this scenario is that a higher threshold highlights FEWER
      // words. Asserted against the same page at level 1 rather than a magic
      // count, so the check survives the corpus or the dictionary changing.
      check('a high threshold still marks something', rendered.marks > 0, true);
      check('and the text is still there', rendered.first.length > 0, true);

      await page.selectOption('#threshold', '1');
      await page.waitForFunction(
        (before) => document.querySelectorAll('.mark').length > before,
        rendered.marks,
        { timeout: 10000 },
      );
      const atLevelOne = await page.evaluate(() => document.querySelectorAll('.mark').length);
      check('and level 1 marks strictly more', atLevelOne > rendered.marks, true);
    }

    await context.close();
  }

  // --- The mark comparison sheet --------------------------------------------
  //
  // `marks.html` had no coverage at all, and it is a page whose whole job is to
  // render marks — so a mistake in it produces a convincing-looking empty sheet,
  // which is exactly the failure a person cannot distinguish from "the marks are
  // subtle". It also writes its own marking loop rather than reusing the panel's,
  // so nothing else exercises it.
  console.log('\nmarks.html — the mark comparison sheet');

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    await page.goto(`http://127.0.0.1:${PORT}/tools/ui/marks.html`, { waitUntil: 'load' });
    await page.waitForSelector('.col', { timeout: 5000 });

    const sheet = await page.evaluate(() => {
      const cols = [...document.querySelectorAll('.col')];
      return {
        cols: cols.length,
        titles: cols.map((c) => c.querySelector('h2')?.textContent ?? ''),
        // Each column must carry its OWN treatment class, or both columns render
        // identically and the page compares nothing.
        classes: cols.map((c) => [...c.classList].filter((n) => n.startsWith('mark-'))),
        marks: cols.map((c) => c.querySelectorAll('.mark').length),
        borderWidths: cols.map((c) => [
          ...new Set([...c.querySelectorAll('.mark')].map((m) => getComputedStyle(m).borderBottomWidth)),
        ]),
        backgrounds: cols.map((c) => [
          ...new Set([...c.querySelectorAll('.mark')].map((m) => getComputedStyle(m).backgroundColor)),
        ]),
        legend: document.querySelectorAll('#legend .mark').length,
      };
    });

    check('both treatments are on the page', sheet.titles, ['Underline', 'Highlight']);
    check('each column carries its own treatment class', sheet.classes, [['mark-underline'], ['mark-highlight']]);
    check('every column has marks', sheet.marks.every((n) => n > 0), true);

    // The two treatments must actually differ, or the page is decorative. The
    // underline leaves no background; the highlight washes behind the word. That
    // is the property that makes them two treatments rather than two headings.
    const [underlineBgs, highlightBgs] = sheet.backgrounds;
    const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
    check('the underline draws no background', underlineBgs.every(transparent), true);
    check('the highlight draws one', highlightBgs.some((c) => !transparent(c)), true);

    // Every level is named in the legend, so the ramp can be read as a sequence.
    check('the legend names every level of the list', sheet.legend, 5);

    check('no console or page error', errors, []);

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
