/**
 * The reader in Firefox.
 *
 * ## Why this file is mostly an attempt
 *
 * The extension targets Firefox, and until this file nothing executed it there. The
 * browser tier is Chromium-only, so the two mechanisms that most differ between the
 * browsers had no coverage at all:
 *
 *   - the sidebar API, `sidebarAction.toggle` against Chrome's `sidePanel.open`, which
 *     `service-worker.js` feature-detects but which nothing ever called;
 *   - `world: "MAIN"` content scripts, supported in Firefox from 128 but plumbed
 *     differently from Chrome's.
 *
 * A test that claims to cover those and quietly does nothing is worse than no test, so
 * this one is explicit: it attempts a real Firefox, and if the environment cannot
 * drive one it prints WHY and SKIPS, with a non-zero exit only on a real failure.
 * `run-browser.mjs` treats a SKIP as skipped, not as a pass.
 *
 * ## What was measured about this environment
 *
 * Attempted 2026-10-18 on WSL2, Firefox 155 (Playwright's build):
 *
 *   - `firefox --version` works, and Playwright launches Firefox when the profile is
 *     pre-seeded. With an EMPTY profile it segfaults, so the profile is seeded first.
 *   - `about:` pages cannot be navigated through Playwright, so `about:debugging`
 *     cannot be used to drive the add-on.
 *   - Sideloading an unsigned XPI does not register it; `web-ext run` DOES report
 *     "Installed ... as a temporary add-on", so the extension IS loadable, but
 *     `web-ext` holds the browser for as long as it runs and leaves no profile with
 *     the add-on registered for a second process to attach to.
 *
 * So the attempt below is real and the skip is honest. On a machine where Playwright
 * Firefox can load the extension, the assertions run.
 *
 * Run with: `npm run test:browser`
 */

import { firefox } from 'playwright';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
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

/** A profile with extensions enabled, since an empty one segfaults this Firefox. */
function seedProfile() {
  const profile = mkdtempSync(join(tmpdir(), 'iu-firefox-'));
  mkdirSync(join(profile, 'extensions'), { recursive: true });
  writeFileSync(
    join(profile, 'prefs.js'),
    [
      'user_pref("xpinstall.signatures.required", false);',
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("extensions.enabledScopes", 15);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
    ].join('\n'),
  );
  return profile;
}

/**
 * Launch Firefox with the extension, or return null with a printed reason.
 *
 * Firefox has no `--load-extension` equivalent, so the extension is placed in the
 * profile's `extensions/` directory and the prefs above make the profile load it at
 * startup. If that does not produce a `moz-extension://` origin, the environment
 * cannot host the add-on and this returns null rather than pretending.
 *
 * @returns {Promise<{context: object, base: string, close: Function}|null>}
 */
async function launchFirefoxWithExtension() {
  const profile = seedProfile();
  let context;
  try {
    context = await firefox.launchPersistentContext(profile, {
      headless: true,
      firefoxUserPrefs: {
        'xpinstall.signatures.required': false,
        'extensions.autoDisableScopes': 0,
        'extensions.enabledScopes': 15,
      },
    });
  } catch (error) {
    console.log(`  SKIP  Firefox will not launch here: ${error.message.split('\n')[0]}`);
    return null;
  }

  // Firefox assigns the extension a uuid; the registry records it once the profile has
  // been written, which happens on launch.
  const registry = join(profile, 'extensions.json');
  if (!existsSync(registry)) {
    await context.close();
    console.log('  SKIP  Firefox launched but wrote no extension registry.');
    return null;
  }

  const { readFileSync } = await import('node:fs');
  const addons = JSON.parse(readFileSync(registry, 'utf8')).addons ?? [];
  const ours = addons.find((addon) => addon.id === 'iu@lhernandez0.github.io' && addon.uuid);
  if (!ours) {
    await context.close();
    console.log(
      '  SKIP  Firefox will not load an unsigned sideloaded extension in this environment.',
    );
    console.log('        `web-ext run` reports it installs, but leaves no profile to attach to.');
    return null;
  }

  return { context, base: `moz-extension://${ours.uuid}`, close: () => context.close() };
}

const started = await launchFirefoxWithExtension();

if (!started) {
  console.log('\n  0/0 checks passed (Firefox cannot be driven here; see the messages above)');
  process.exit(0);
}

try {
  // The sidebar page, loaded as a real extension origin. This is the surface the
  // sidebar API opens, and getting a 200 from it proves the manifest's
  // `sidebar_action` points at a page that exists and that a `moz-extension://`
  // origin serves it. A rename in `sidepanel.html` would 404 here and nowhere else.
  const page = await started.context.newPage();
  const response = await page.goto(`${started.base}/src/sidepanel/sidepanel.html`);
  check('the sidebar page is served', response?.status(), 200);

  await page.waitForTimeout(300);
  const rendered = await page.evaluate(() => ({
    transcript: Boolean(document.getElementById('transcript')),
    settings: Boolean(document.getElementById('settings-view')),
    // The panel's own script reads `globalThis.browser ?? globalThis.chrome`. On a
    // Firefox extension page `browser` exists, so this asserts the branch the panel
    // takes there rather than the one it takes under the Chromium stub.
    hasBrowserGlobal: typeof globalThis.browser !== 'undefined',
  }));
  check('the sidebar markup is the shipped markup', rendered.transcript && rendered.settings, true);
  check('and Firefox exposes the browser namespace the panel prefers', rendered.hasBrowserGlobal, true);
} finally {
  await started.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
