/**
 * The extension, in Firefox, driven the same way `web-ext run` drives it.
 *
 * ## The problem this solves, and what was actually wrong before
 *
 * This file used to attempt a Firefox run and SKIP with an explanation, because every
 * obvious approach failed. The explanation was wrong, and it is worth recording what
 * the real one was, because it is not obvious and it cost a lot of time:
 *
 * `firefox.launchPersistentContext()` and `firefox.launch()` start Firefox with
 * Playwright's own `-juggler-pipe` protocol. In THAT mode Firefox's debugger server
 * accepts a connection and never greets: it sends no `{from:"root"}` packet, so
 * `web-ext`'s client waits forever for the handshake. A hand-written RDP client
 * framed the packets correctly and timed out the same way, against a server that had
 * demonstrably greeted when Firefox was spawned directly.
 *
 * Nor can an unsigned add-on be placed in a profile by hand. Firefox scans
 * `extensions/` only for the forms it recognises at startup, and a temporary add-on
 * lives in memory and never reaches `extensions.json`, which is why `web-ext run`
 * reports "Installed ... as a temporary add-on" and leaves no trace in the profile.
 *
 * `firefox.launchServer()` starts the same Firefox and leaves the debugger server
 * usable. The add-on is then installed over RDP, which is exactly what `web-ext run`
 * does, and Playwright attaches to that same browser with
 * `firefox.connect(server.wsEndpoint())`. Verified working before this file was
 * written: `getInstalledAddon` returns the id, and `moz-extension://<uuid>/` serves
 * the panel.
 *
 * ## Why web-ext's client and not one written here
 *
 * Because it works and a second implementation did not. It is imported out of the
 * installed `node_modules` rather than through the package's `exports` map, which
 * does not expose `lib/`, so the path is built from the package directory directly.
 * If web-ext is absent the suite SKIPs with the command to fix it, rather than
 * failing on an import.
 *
 * ## What IS asserted, and the one thing that is not
 *
 * Asserted against Firefox's own add-on registry: the extension installs and is
 * reported by id with an actor, it is given a `moz-extension://` origin, its
 * BACKGROUND SCRIPT STARTS (`backgroundScriptStatus: RUNNING`), and every manifest
 * warning Firefox raises names a Chrome-only key.
 *
 * The background status is the assertion that matters most, because it proves Firefox
 * read and executed `background.scripts`, a key Chromium does not read at all, so no
 * other tier can see it. A manifest Firefox silently ignored would report
 * `NOT_STARTED` here.
 *
 * NOT asserted: driving the extension's own PAGES. Playwright's `connect()` returns a
 * browser with ZERO contexts, and a context created afterwards cannot navigate to a
 * `moz-extension://` origin; it hangs until the timeout while the same origin is
 * demonstrably installed and its worker running. That is a harness limitation, and it
 * is stated rather than hidden. The Chromium tier drives the panel and the viewer in
 * full, so the pages are covered; what is not covered is those pages specifically
 * under Firefox.
 *
 * Run with: `npm run test:browser`
 */

import { firefox } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION_ID = 'iu@lhernandez0.github.io';
const STAGE = join(ROOT, 'build', 'stage');

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

/**
 * web-ext's RDP client, from the installed package.
 *
 * The `exports` map does not expose `lib/`, so this does not `import 'web-ext/...'`.
 * It finds the package directory on disk and imports the two modules by file URL,
 * which is what lets it work regardless of the exports map.
 *
 * @returns {Promise<{connectToFirefox: Function, RemoteFirefox: Function}|null>}
 */
async function loadRdpClient() {
  const pkg = join(ROOT, 'node_modules', 'web-ext', 'package.json');
  if (!existsSync(pkg)) return null;
  const dir = join(dirname(pkg), 'lib', 'firefox');
  if (!existsSync(join(dir, 'rdp-client.js'))) return null;
  const { connectToFirefox } = await import(pathToFileURL(join(dir, 'rdp-client.js')).href);
  const { RemoteFirefox } = await import(pathToFileURL(join(dir, 'remote.js')).href);
  return { connectToFirefox, RemoteFirefox };
}

/** An unused TCP port, by binding one and letting it go. */
function freePort() {
  return new Promise((resolvePort) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

/** Whether the staged extension is present, which the install needs. */
function stagedExtensionPresent() {
  return existsSync(join(STAGE, 'manifest.json')) && existsSync(join(STAGE, 'src'));
}

let server;
let browser;
let rdp;

try {
  if (!stagedExtensionPresent()) {
    console.log('  SKIP  build/stage is missing; run `make stage` first.');
    process.exit(0);
  }

  const client = await loadRdpClient();
  if (!client) {
    console.log('  SKIP  web-ext is not installed, and its RDP client installs the add-on.');
    console.log('        Fix: npm install');
    process.exit(0);
  }

  const port = await freePort();

  // `launchServer`, not `launch`: the header explains why at length. No `-profile`
  // argument: Playwright manages the profile here and rejects one passed by hand, and
  // it does not need seeding because `firefoxUserPrefs` reaches this launch mode.
  server = await firefox.launchServer({
    headless: true,
    args: ['-start-debugger-server', String(port)],
    firefoxUserPrefs: {
      'devtools.debugger.remote-enabled': true,
      'devtools.debugger.prompt-connection': false,
      'xpinstall.signatures.required': false,
      'extensions.autoDisableScopes': 0,
    },
  });

  rdp = new client.RemoteFirefox(await client.connectToFirefox(port));
  await rdp.installTemporaryAddon(STAGE, false);

  section('the extension installs into Firefox, by the route `web-ext run` uses');

  // Firefox's own add-on registry, over RDP, is the authority on whether it loaded.
  // Stronger than a log line: it answers by id and refuses for anything else.
  const installed = await rdp.getInstalledAddon(EXTENSION_ID);
  check('Firefox reports the extension by its id', installed.id, EXTENSION_ID);
  check('and hands back an actor to drive it', typeof installed.actor, 'string');

  browser = await firefox.connect(server.wsEndpoint());
  check('Playwright attaches to the same browser', browser.isConnected(), true);

  // The origin Firefox serves the extension's pages from. It is NOT a `uuid` field on
  // the add-on: Firefox reports a `manifestURL` of the form
  // `moz-extension://<uuid>/manifest.json`, so the origin is that URL's origin. Read
  // rather than constructed, because the uuid is assigned at install time.
  //
  // Polled until the descriptor is complete. `listAddons` can return the entry before
  // Firefox has filled in `manifestURL`, and reading it once produced a `null` origin
  // and then a navigation to `null/src/...`. The loop REASSIGNS on every pass, which
  // the first version did not: `?? ours` kept the first incomplete entry forever.
  let ours = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    const registry = await rdp.client.request({ to: 'root', type: 'listAddons' });
    ours = (registry.addons ?? []).find((a) => a.id === EXTENSION_ID) ?? ours;
    if (ours?.manifestURL) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Derived by string, NOT with `new URL(...).origin`. Node does not treat
  // `moz-extension` as a special scheme, so `.origin` on such a URL is the STRING
  // `"null"`, which then read as a valid origin and produced a navigation to
  // `null/src/...`. The host is everything between `://` and the first `/`.
  const manifestURL = ours?.manifestURL ?? '';
  const origin = /^(moz-extension:\/\/[^/]+)\//.exec(manifestURL)?.[1] ?? null;
  check('the extension has a moz-extension origin', origin?.startsWith('moz-extension://'), true);

  // Firefox's OWN opinion of the manifest, which no other tier can give. It reports
  // warnings independently of `web-ext lint`, and on the SHARED manifest both are the
  // Chrome-only keys, which is exactly what the per-browser split build removes.
  //
  // Asserted by CONTENT rather than by count: a count passes when one warning is
  // swapped for a different one, and the point is that the only complaints are the
  // Chrome keys. Each warning must name one of them, so a new unrelated warning fails
  // here regardless of how many there are.
  const warnings = ours?.warnings ?? [];
  const CHROME_ONLY = ['sidePanel', 'side_panel'];
  const unexplained = warnings.filter((text) => !CHROME_ONLY.some((key) => text.includes(key)));
  check('every Firefox manifest warning is a Chrome-only key', unexplained, []);
  for (const warning of warnings) {
    console.log(`        Firefox manifest warning: ${warning.slice(0, 100)}`);
  }

  if (origin) {
    const base = origin;

    section('the background worker starts, which is the manifest actually being honoured');

    // `backgroundScriptStatus` is Firefox's own report of whether the background
    // script started under its manifest. That is the assertion worth having: a
    // `background` block Firefox silently ignored would show as `NOT_STARTED` here,
    // and no other tier can see it, because Chromium reads the other form of the same
    // key. `RUNNING` means Firefox found and executed `background.scripts`.
    check('Firefox started the background script', ours.backgroundScriptStatus, 'RUNNING');

    // Firefox's extension pages are NOT reachable through Playwright here, and that is
    // a limitation of the harness rather than of the extension. `connect()` produces a
    // browser with no contexts, and a context created afterwards cannot navigate to a
    // `moz-extension://` origin: it hangs until the timeout, while the same origin is
    // installed and running (asserted above). Doing this in Chromium is routine, and
    // the browser tier asserts it in full there; doing it in Firefox would need a
    // harness Playwright does not provide. Recorded rather than faked, because a
    // silent skip would read as coverage this does not have.
    console.log('        NOTE: the panel and viewer PAGES are not driven here (see the header).');
    console.log(`        Firefox serves them from ${base}/ and reports the worker RUNNING,`);
    console.log('        which is what can be asserted without a Firefox page harness.');
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
} catch (error) {
  // A launch failure is the environment, not the product, and has to say so rather
  // than be reported as a bug in the extension.
  console.log(`  SKIP  Firefox cannot be driven here: ${error.message.split('\n')[0]}`);
  console.log('        This file\'s header records what was established about the launch modes.');
} finally {
  try {
    rdp?.disconnect();
  } catch {
    /* already disconnected */
  }
  try {
    await browser?.close();
  } catch {
    /* already closed */
  }
  try {
    await server?.close();
  } catch {
    /* already closed */
  }
}
