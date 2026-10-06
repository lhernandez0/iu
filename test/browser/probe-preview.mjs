/**
 * Ad-hoc probe for the preview server while iterating on it.
 *
 * Not part of `npm test` — excluded because it asserts nothing and prints for a
 * person to read. Kept in the repository rather than /tmp because Node cannot
 * resolve `playwright` from /tmp, which cost two failed attempts to learn.
 *
 *   node test/browser/probe-preview.mjs [port]
 */

import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const PORT = Number(process.argv[2] ?? 8097);

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto(`http://127.0.0.1:${PORT}/tools/ui/?scenario=bilingual`, { waitUntil: 'load' });
await page
  .waitForFunction(() => !document.getElementById('status')?.textContent?.includes('Looking'), null, { timeout: 15000 })
  .catch(() => console.log('(timed out waiting for the panel to render)'));

const report = await page.evaluate(() => ({
  status: document.getElementById('status')?.textContent ?? '',
  rows: document.querySelectorAll('.row').length,
  marks: document.querySelectorAll('.mark').length,
  list: document.getElementById('list')?.selectedOptions?.[0]?.textContent ?? '(none)',
  threshold: document.getElementById('threshold')?.selectedOptions?.[0]?.textContent ?? '(none)',
  mt: [...document.querySelectorAll('.line-translate input')].map((input) => input.id),
  layout: document.getElementById('layout')?.value ?? '(missing)',
  studyFirst: document.querySelector('.row .primary')?.textContent ?? '',
}));

console.log('errors:    ', errors.length ? errors : 'none');
for (const [key, value] of Object.entries(report)) console.log(`${key.padEnd(11)}`, value);

await browser.close();
