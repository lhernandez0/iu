/**
 * Probe the audio track selector in the preview player.
 *
 * Ad-hoc. Prints for a person to read, asserts nothing, so it is not part of
 * `npm test`.
 *
 *   node test/browser/probe-audio-tracks.mjs [port]
 *
 * ## Why it runs the page TWICE
 *
 * `audioTracks` does not exist in a released Chrome — only behind
 * `--enable-blink-features=AudioVideoTracks`. So there are two states worth
 * checking and only one of them is a working feature:
 *
 *   flagged   — the API is there, the control must list the file's tracks and
 *               actually switch between them.
 *   unflagged — what every real user gets today, including in the extension. The
 *               control must EXPLAIN itself rather than vanish, because a missing
 *               button raises "where is it?" and a disabled one with a reason
 *               answers it.
 *
 * Checking only the flagged run would report a feature nobody can use.
 */

import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const PORT = Number(process.argv[2] ?? 8099);
const FILES = [
  // Two real AAC tracks, built with ffmpeg. Neither carries a title or a language
  // tag, which is the common case and the one that tests the fallback naming.
  { file: 'two-audio.mkv', expect: 'choice' },
  { file: 'two-audio.mp4', expect: 'choice' },
  // One track: the control must stay out of the way entirely.
  { file: 'preview.mp4', expect: 'single' },
];

/**
 * @param {string[]} args
 * @param {string} label
 */
async function run(args, label) {
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', ...args],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  console.log(`\n=== ${label} ===`);
  if (errors.length) console.log('errors:', errors);

  for (const { file, expect } of FILES) {
    await page.goto(`http://127.0.0.1:${PORT}/tools/ui/player.html?src=/tools/ui/assets/${file}`, {
      waitUntil: 'load',
    });
    // `audioTracks` is populated by the demuxer, so it is only real after metadata.
    await page
      .waitForFunction(() => Number(document.getElementById('pp-scrubber')?.max) > 0, null, { timeout: 15000 })
      .catch(() => console.log(`(${file}: metadata never loaded)`));

    const report = await page.evaluate(() => {
      const video = document.querySelector('video');
      const button = document.getElementById('pp-audio');
      const select = document.getElementById('pp-audio-track');
      const panel = document.getElementById('pp-audio-panel');
      return {
        apiPresent: 'audioTracks' in video,
        trackCount: 'audioTracks' in video ? video.audioTracks.length : null,
        buttonHidden: button.hidden,
        buttonDisabled: button.disabled,
        badge: button.querySelector('.pp-audio-badge')?.textContent ?? '',
        expanded: button.getAttribute('aria-expanded'),
        title: button.title,
        panelHidden: panel.hidden,
        options: [...select.options].map((option) => option.textContent),
      };
    });

    // Now exercise it: open the panel, then pick the last track.
    await page.evaluate(() => document.getElementById('pp-audio')?.click());
    const opened = await page.evaluate(() => ({
      panelHidden: document.getElementById('pp-audio-panel').hidden,
      options: [...document.getElementById('pp-audio-track').options].map((o) => o.textContent),
      note: document.getElementById('pp-audio-note').textContent,
      expanded: document.getElementById('pp-audio').getAttribute('aria-expanded'),
    }));

    let switched = null;
    if (report.apiPresent && report.trackCount > 1) {
      await page.selectOption('#pp-audio-track', '1');
      switched = await page.evaluate(() => {
        const video = document.querySelector('video');
        return {
          enabled: [...video.audioTracks].map((track) => track.enabled),
          selectedOption: document.getElementById('pp-audio-track').value,
        };
      });
    }

    console.log(`--- ${file} (expected: ${expect}) ---`);
    console.log(JSON.stringify({ ...report, opened, switched }, null, 2));

    // A picture of each meaningful state. `two-audio.mkv` with the panel open is the
    // feature; `preview.mp4` is the "nothing to choose" case the control must stay
    // out of the way for.
    if (label.startsWith('WITH the flag') && file === 'two-audio.mkv') {
      await page.locator('.pp-bar').screenshot({ path: 'tools/ui/assets/player-audio-choice.png' });
    }
    if (label.startsWith('WITHOUT') && file === 'two-audio.mkv') {
      await page.locator('.pp-bar').screenshot({ path: 'tools/ui/assets/player-audio-unavailable.png' });
    }
  }

  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
}

await run([], 'WITHOUT the flag (what a released browser gives us)');
await run(['--enable-blink-features=AudioVideoTracks'], 'WITH the flag (the API present)');
