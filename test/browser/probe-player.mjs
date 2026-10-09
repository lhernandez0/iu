/**
 * Ad-hoc probe for the preview PLAYER while iterating on it.
 *
 * Prints for a person to read, asserts nothing, so it is not part of `npm test`.
 * Kept in the repository rather than /tmp because Node cannot resolve `playwright`
 * from /tmp.
 *
 *   node test/browser/probe-player.mjs [port]
 */

import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const PORT = Number(process.argv[2] ?? 8099);

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto(`http://127.0.0.1:${PORT}/tools/ui/player.html`, { waitUntil: 'load' });

// The band is painted on `loadedmetadata`, so wait for the duration to be known
// rather than for load — otherwise every measurement reads a bar with nothing in it.
await page
  .waitForFunction(() => Number(document.getElementById('pp-scrubber')?.max) > 0, null, { timeout: 20000 })
  .catch(() => console.log('(timed out waiting for metadata — the media never loaded)'));

const bandOf = () =>
  page.evaluate(() => {
    const spans = [...document.querySelectorAll('#pp-cues span')];
    return {
      spans: spans.length,
      colours: [...new Set(spans.map((span) => getComputedStyle(span).backgroundColor))],
      widths: spans.map((span) => Number((span.getBoundingClientRect().width).toFixed(1))),
      bandVisible: getComputedStyle(document.getElementById('pp-cues')).display !== 'none' &&
        document.getElementById('pp-cues').childElementCount > 0,
      pressed: document.getElementById('pp-difficulty').getAttribute('aria-pressed'),
      label: document.getElementById('pp-difficulty').title,
      scrubberVisible: document.getElementById('pp-scrubber').getBoundingClientRect().height > 0,
    };
  });

const report = { on: await bandOf() };

await page.click('#pp-difficulty');
report.off = await bandOf();

await page.click('#pp-difficulty');
report.backOn = await bandOf();

// Reload: the toggle has to survive, the same as every other setting in the mock.
await page.reload({ waitUntil: 'load' });
await page
  .waitForFunction(() => Number(document.getElementById('pp-scrubber')?.max) > 0, null, { timeout: 20000 })
  .catch(() => {});
await page.click('#pp-difficulty');
await page.reload({ waitUntil: 'load' });
await page
  .waitForFunction(() => Number(document.getElementById('pp-scrubber')?.max) > 0, null, { timeout: 20000 })
  .catch(() => {});
report.afterReloadOff = await bandOf();

// Both states, so the difference can be judged side by side rather than
// remembered. The scrubber stays in both — only the band is optional.
await page.screenshot({ path: 'tools/ui/assets/player-difficulty-off.png' });
await page.click('#pp-difficulty');
await page.screenshot({ path: 'tools/ui/assets/player-difficulty-on.png' });
// And a crop of the bar itself, which is where the detail actually is.
const bar = await page.$('.pp-bar');
if (bar) await bar.screenshot({ path: 'tools/ui/assets/player-difficulty-bar.png' });

// Sample RENDERED PIXELS inside each band's own x-window.
//
// The CSS says the band is painted, and the stacking order says it should show
// through the unplayed track — but neither is evidence that a person can see it.
// The band sits BEHIND a track that is itself translucent, so the composite is a
// mix and the only honest check is the pixel.
//
// A whole-row scan is not that check: it produced ~57 "bands" whether the tint was
// on or off, because it measured anti-aliasing along the track rather than the
// tint. Measuring the mean colour inside each band's own rect, and the difference
// between the two states, is what actually answers "can this be seen".
let lastWindows = [];
async function sampleWindows(fixed) {
  const windows = fixed ?? (await page.evaluate(() =>
    [...document.querySelectorAll('#pp-cues span')].map((span) => {
      const rect = span.getBoundingClientRect();
      const bar = document.querySelector('.pp-scrub').getBoundingClientRect();
      return rect.width < 4
        ? null
        : { x: Math.round(rect.left - bar.left + 2), w: Math.round(rect.width - 4) };
    }).filter(Boolean)));
  const png = await page.locator('.pp-scrub').screenshot();
  const means = await page.evaluate(
    async ({ base64, windows }) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${base64}`)).blob(),
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const y = Math.floor(bitmap.height / 2);
      return windows.map(({ x, w }) => {
        const row = context.getImageData(x, y, w, 1).data;
        const total = [0, 0, 0];
        for (let i = 0; i < w; i += 1) for (let c = 0; c < 3; c += 1) total[c] += row[i * 4 + c];
        return total.map((v) => Math.round(v / w));
      });
    },
    { base64: png.toString('base64'), windows },
  );
  lastWindows = windows;
  return { windows: windows.length, means };
}

// The SAME windows measured in both states. Measuring only the x-ranges where a
// band happens to be when it is on would compare a tinted stretch against nothing;
// the question is what that stretch looks like with the tint removed, so the
// windows are captured once and held.
await sampleWindows();
const pinned = lastWindows;
report.pixelsOn = await sampleWindows(pinned);
await page.click('#pp-difficulty');
report.pixelsOff = await sampleWindows(pinned);
await page.click('#pp-difficulty');




console.log('errors:', errors.length ? errors : 'none');
for (const [key, value] of Object.entries(report)) console.log(key.padEnd(15), JSON.stringify(value));

await browser.close();
