/**
 * Probe the volume control in the preview player.
 *
 * Ad-hoc. Prints for a person to read, asserts nothing, so it is not part of
 * `npm test`.
 *
 *   node test/browser/probe-volume.mjs [port]
 *
 * Checks the two things that are easy to get wrong and invisible in a screenshot:
 *
 *   1. Whether the volume curve is applied. A linear slider and a squared one look
 *      identical; only `video.volume` for a given slider position tells them apart.
 *   2. Whether `hidden` on an SVG `<g>` actually hides it. `hidden` is an HTML
 *      attribute, and SVG elements live in a different namespace — this is reported
 *      as the computed `display`, because reading the attribute back would only
 *      confirm that we set it, not that the browser honoured it.
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
await page.waitForTimeout(1500);

/** The state of the volume group. */
const state = () =>
  page.evaluate(() => {
    const video = document.querySelector('video');
    const waves = document.getElementById('pp-volume-waves');
    const cross = document.getElementById('pp-volume-cross');
    return {
      slider: Number(document.getElementById('pp-volume').value),
      videoVolume: Number(video.volume.toFixed(4)),
      muted: video.muted,
      mutePressed: document.getElementById('pp-mute').getAttribute('aria-pressed'),
      muteTitle: document.getElementById('pp-mute').title,
      // Computed, not the attribute — the question is whether SVG honoured it.
      wavesDisplay: getComputedStyle(waves).display,
      crossDisplay: getComputedStyle(cross).display,
    };
  });

/** The curve, sampled at the positions a person would actually stop at. */
const report = { initial: await state(), curve: [] };
for (const value of [100, 75, 50, 25, 0]) {
  await page.evaluate((v) => {
    const slider = document.getElementById('pp-volume');
    slider.value = String(v);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  const at = await state();
  report.curve.push({ slider: value, videoVolume: at.videoVolume, muted: at.muted });
}

// Unmute, then mute, and read the level back.
await page.evaluate(() => {
  const slider = document.getElementById('pp-volume');
  slider.value = '40';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
report.beforeMute = await state();
await page.click('#pp-mute');
report.muted = await state();
await page.click('#pp-mute');
report.unmuted = await state();

// And the reload path, which is the whole reason volume is persisted.
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);
report.afterReload = await state();

await page.locator('.pp-bar').screenshot({ path: 'tools/ui/assets/player-volume.png' });
await page.click('#pp-mute');
await page.locator('.pp-bar').screenshot({ path: 'tools/ui/assets/player-volume-muted.png' });

// The transport row is now full — transport, cue stepping, speed, volume and five
// toggles. If it wraps, the bar grows and covers more of the picture, so it is worth
// measuring rather than assuming. `scrollWidth > clientWidth` is the row overflowing;
// a row height of more than one button means it wrapped.
report.layout = [];
for (const width of [1440, 1280, 1024, 900, 800]) {
  await page.setViewportSize({ width, height: 720 });
  await page.waitForTimeout(120);
  report.layout.push(
    await page.evaluate((at) => {
      const row = document.querySelector('.pp-row-transport');
      const bar = document.getElementById('pp-bar');
      const button = row.querySelector('.pp-button');
      return {
        width: at,
        rowHeight: Math.round(row.getBoundingClientRect().height),
        buttonHeight: Math.round(button.getBoundingClientRect().height),
        wrapped: row.getBoundingClientRect().height > button.getBoundingClientRect().height * 1.6,
        overflow: row.scrollWidth > row.clientWidth + 1,
        barHeight: Math.round(bar.getBoundingClientRect().height),
      };
    }, width),
  );
}

// The narrowest viewport the transport row still fits on ONE line, measured with the
// volume group present and hidden. The difference is what volume costs in width, and
// it is worth knowing exactly: below that threshold the row wraps and the bar grows by
// a line, covering more of the picture.
async function rowFitThreshold() {
  let wraps = 600;
  let fits = 1400;
  while (fits - wraps > 2) {
    const mid = Math.floor((wraps + fits) / 2);
    await page.setViewportSize({ width: mid, height: 720 });
    await page.waitForTimeout(60);
    const didWrap = await page.evaluate(
      () => document.querySelector('.pp-row-transport').getBoundingClientRect().height > 40,
    );
    if (didWrap) wraps = mid;
    else fits = mid;
  }
  return fits;
}

report.fitsAtWithVolume = await rowFitThreshold();
await page.evaluate(() => {
  document.querySelector('.pp-volume').style.display = 'none';
});
report.fitsAtWithoutVolume = await rowFitThreshold();
await page.evaluate(() => {
  document.querySelector('.pp-volume').style.display = '';
});

console.log('errors:', errors.length ? errors : 'none');
console.log(JSON.stringify(report, null, 2));

await browser.close();
