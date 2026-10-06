/**
 * Reproduce the Trusted Types failure that cost the capture.
 *
 *   node tools/probe-trusted-types.mjs
 *
 * Opens NOTHING. Every response is served from a local route, so the browser
 * never leaves the machine. This exists because the capture failed on a
 * `parseFromString` call and the explanation for WHY has to be demonstrated
 * rather than asserted — the whole point of the guard we added is that we stop
 * reasoning from belief.
 *
 * Three contexts, because the difference between them is the finding:
 *   1. an ordinary page, no CSP
 *   2. an ordinary page WITH `require-trusted-types-for 'script'`
 *   3. an extension page, which is where the capture tool ran the call
 */

import { chromium } from 'playwright';
import { findChrome } from './lib/chrome.mjs';
import { extensionIdForPath } from '../test/browser/harness.mjs';

const EXTENSION_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    `--disable-extensions-except=${EXTENSION_ROOT}`,
    `--load-extension=${EXTENSION_ROOT}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const context = await browser.newContext();

await context.route('**/plain**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>plain</title>' }),
);
await context.route('**/tt**', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    headers: { 'Content-Security-Policy': "require-trusted-types-for 'script'" },
    body: '<!doctype html><title>tt</title>',
  }),
);

const probe = async (url, label) => {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const out = await page.evaluate(() => {
      try {
        new DOMParser().parseFromString('<transcript><text start="0">hi</text></transcript>', 'text/xml');
        return 'WORKED';
      } catch (error) {
        return `THREW: ${error.message}`;
      }
    });
    console.log(`  ${label.padEnd(46)} ${out}`);
  } catch (error) {
    console.log(`  ${label.padEnd(46)} could not open: ${error.message.split('\n')[0]}`);
  }
  await page.close();
};

console.log('\n  Is DOMParser.parseFromString allowed here?\n');
await probe('https://example.test/plain', 'plain page, no CSP');
await probe('https://example.test/tt', 'page with require-trusted-types-for');

// The context the capture tool actually used.
const extensionId = extensionIdForPath(EXTENSION_ROOT);
await probe(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`, 'EXTENSION page (capture used this)');

await browser.close();
console.log('');
