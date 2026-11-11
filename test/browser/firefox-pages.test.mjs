/**
 * Firefox extension pages, driven through WebDriver.
 *
 * Playwright's Firefox connection can install the add-on and prove its background
 * script starts, but it cannot navigate a page to `moz-extension://`. That is a
 * limitation of that harness, not of Firefox. This file uses geckodriver and
 * Selenium WebDriver instead, which can drive the panel and viewer pages under a
 * real Firefox.
 *
 * It is deliberately an extension-page smoke test, not a replacement for the
 * manual YouTube pass. The Chromium tier owns the full YouTube fixture flow. This
 * proves that the Firefox package loads its own pages, that the no-source state is
 * a sentence, that Settings and the theme control work, and that the viewer page
 * loads. Those are the places where a browser-specific page regression would show
 * up before a manual pass.
 *
 * Run with: `npm run test:browser`
 */

import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox as playwrightFirefox } from 'playwright';
import { start as startGeckodriver } from 'geckodriver';
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STAGE = join(ROOT, 'build', 'stage-firefox');
const EXTENSION_ID = 'iu@lhernandez0.github.io';

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

/** An unused TCP port, by binding one and letting it go. */
function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** @param {string} url @param {object} [options] */
async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitForHttp(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await request(url);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`timed out waiting for ${url}`);
}

const staged = existsSync(join(STAGE, 'manifest.json')) && existsSync(join(STAGE, 'src'));
if (!staged) {
  console.log('  SKIP  build/stage-firefox is missing; run `make stage TARGET=firefox`.');
  process.exit(0);
}

const firefoxPath = playwrightFirefox.executablePath();
if (!existsSync(firefoxPath)) {
  console.log('  SKIP  Playwright Firefox is not installed; run `npx playwright install firefox`.');
  process.exit(0);
}

let gecko;
let driver;

try {
  const port = await freePort();
  // `allowSystemAccess` is a geckodriver flag, not a Firefox capability. The page
  // test needs chrome context once to read Firefox's extension UUID, because
  // `moz-extension://` URLs use the generated UUID rather than the add-on id.
  gecko = await startGeckodriver({ port, allowSystemAccess: true });
  await waitForHttp(`http://127.0.0.1:${port}/status`);

  const options = new firefox.Options()
    .setBinary(firefoxPath)
    .addArguments('-headless');
  options.setPreference('xpinstall.signatures.required', false);
  options.setPreference('extensions.autoDisableScopes', 0);

  driver = await new Builder()
    .usingServer(`http://127.0.0.1:${port}`)
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .build();

  const installed = await driver.installWebExtension(STAGE, { permanent: false });
  check('Firefox installs the staged Firefox package', installed.id, EXTENSION_ID);

  await driver.setContext('chrome');
  const uuidJson = await driver.executeScript(
    "return Services.prefs.getStringPref('extensions.webextensions.uuids')",
  );
  await driver.setContext('content');
  const uuid = JSON.parse(uuidJson)[EXTENSION_ID];
  check('Firefox assigns the extension a page origin', typeof uuid, 'string');

  const origin = `moz-extension://${uuid}`;
  section('the Firefox sidebar page loads and reports a plain no-source state');
  await driver.get(`${origin}/src/sidepanel/sidepanel.html`);
  await driver.wait(until.elementLocated(By.id('status')), 10000);
  check('the panel document loads', await driver.getTitle(), 'IU');
  check('the status is a sentence, not a code', await driver.findElement(By.id('status')).getText(), 'No video on this tab.');

  section('Settings and the independent panel theme work under Firefox');
  await driver.findElement(By.id('settings-toggle')).click();
  await driver.wait(until.elementLocated(By.id('settings-title')), 5000);
  check('Settings opens', await driver.findElement(By.id('settings-title')).getText(), 'Settings');

  await driver.executeScript(`
    const row = [...document.querySelectorAll('.settings-row')]
      .find((r) => r.querySelector('.settings-label')?.textContent === 'Panel theme');
    const select = row?.querySelector('select');
    if (!select) throw new Error('Panel theme control not found');
    select.value = 'swiss';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  // The setting is persisted by the worker; reloading proves the panel paints the
  // stored theme through the Firefox boot path rather than only in memory.
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await driver.navigate().refresh();
  await driver.wait(until.elementLocated(By.id('status')), 10000);
  await driver.wait(
    async () => (await driver.executeScript('return document.documentElement.dataset.theme')) === 'swiss',
    5000,
  );
  check('the stored panel theme is applied after a reload', await driver.executeScript('return document.documentElement.dataset.theme'), 'swiss');

  await driver.findElement(By.id('settings-toggle')).click();
  await driver.wait(until.elementLocated(By.id('settings-title')), 5000);
  await driver.executeScript(`
    const row = [...document.querySelectorAll('.settings-row')]
      .find((r) => r.querySelector('.settings-label')?.textContent === 'Panel theme');
    const select = row?.querySelector('select');
    select.value = 'default';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await driver.navigate().refresh();
  await driver.wait(until.elementLocated(By.id('status')), 10000);
  check('Default removes the panel theme after a reload', await driver.executeScript('return document.documentElement.dataset.theme'), null);

  await driver.findElement(By.id('settings-toggle')).click();
  await driver.wait(until.elementLocated(By.id('settings-title')), 5000);
  await driver.findElement(By.id('diagnostics-toggle')).click();
  await driver.wait(until.elementLocated(By.id('settings-title')), 5000);
  check('Diagnostics opens under Settings', await driver.findElement(By.id('settings-title')).getText(), 'Diagnostics');
  check(
    'the diagnostics view has its local summary or empty state',
    (await driver.findElement(By.id('settings-body')).getText()).length > 0,
    true,
  );

  section('the Firefox viewer page loads without a file');
  await driver.get(`${origin}/src/viewer/viewer.html`);
  await driver.wait(until.elementLocated(By.id('placeholder')), 10000);
  check('the viewer document loads', await driver.getTitle(), 'IU');
  check('the viewer shows its drop target', (await driver.findElement(By.id('placeholder')).getText()).includes('Drop a video here'), true);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
} catch (error) {
  console.log(`\nSUITE ERROR: ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try {
    await driver?.quit();
  } catch {
    /* already closed */
  }
  try {
    gecko?.kill();
  } catch {
    /* already stopped */
  }
}
