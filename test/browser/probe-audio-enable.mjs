/**
 * Is there ANY way to turn the audioTracks API on other than a startup switch?
 *
 * Ad-hoc probe. Prints, asserts nothing.
 *
 *   node test/browser/probe-audio-enable.mjs [port]
 *
 * We know `--enable-blink-features=AudioVideoTracks` works — but that is a COMMAND-LINE
 * switch, which means the person starting the browser sets it, not us. The question this
 * answers is whether anything a PAGE or an EXTENSION contains can turn it on:
 *
 *   - the umbrella `--enable-experimental-web-platform-features`, which IS exposed on
 *     `chrome://flags` as a normal user-facing toggle. If that turns it on, a user could
 *     enable it themselves without a command line;
 *   - `--blink-settings`, the other startup route;
 *   - a runtime attempt from an extension's own page, since extensions get more APIs than
 *     web pages do.
 *
 * If every one of these needs a flag set BEFORE the process starts, then the answer is
 * settled: it is not ours to enable, and no amount of code in the extension changes it.
 */

import { chromium } from 'playwright';
import { launchExtension } from './harness.mjs';
import { findChrome } from '../../tools/lib/chrome.mjs';

const PORT = Number(process.argv[2] ?? 8099);

async function withFlags(label, args, url) {
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...args],
  });
  const page = await browser.newPage();
  await page.goto(url ?? `http://127.0.0.1:${PORT}/tools/ui/player.html`, { waitUntil: 'load' });
  const result = await page.evaluate(() => ({
    audioTracksOnElement: 'audioTracks' in HTMLMediaElement.prototype,
    audioTrackListCtor: typeof globalThis.AudioTrackList,
  }));
  console.log(`  ${label.padEnd(52)} ${JSON.stringify(result)}`);
  await browser.close();
}

console.log('=== startup switches (the browser is started with these) ===');
await withFlags('(nothing)', []);
await withFlags('--enable-blink-features=AudioVideoTracks', ['--enable-blink-features=AudioVideoTracks']);
// The umbrella flag, which chrome://flags exposes to users as a checkbox.
await withFlags('--enable-experimental-web-platform-features', ['--enable-experimental-web-platform-features']);
await withFlags('--blink-settings=audioVideoTracksEnabled=true', ['--blink-settings=audioVideoTracksEnabled=true']);

console.log('\n=== from an extension page, with NO startup switch ===');
// An extension can do things a web page cannot, so this is worth testing separately. If
// the API were reachable by asking nicely from a privileged context, that would be the
// route — and it is the only route that would let US turn it on rather than the user.
try {
  const { context, extensionId, close } = await launchExtension();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`);
  const result = await page.evaluate(() => ({
    audioTracksOnElement: 'audioTracks' in HTMLMediaElement.prototype,
    hasChromeDebugger: typeof chrome?.debugger,
    hasTabs: typeof chrome?.tabs,
    commands: typeof chrome?.commands,
    // Is there any extension API that looks like it could set a feature?
    chromeKeys: Object.keys(globalThis.chrome ?? {}).filter((k) => /feature|flag|setting/i.test(k)),
  }));
  console.log(`  ${'extension page, no switch'.padEnd(52)} ${JSON.stringify(result)}`);
  await close();
} catch (error) {
  console.log(`  extension page failed: ${String(error?.message ?? error)}`);
}
