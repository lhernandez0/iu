/**
 * Verify `src/viewer/audio-tracks.js` against a real file.
 *
 * Ad-hoc probe. Prints for a person to read, asserts nothing.
 *
 *   IU_PROBE_PORT=8099 node test/browser/probe-audio-tracks-module.mjs
 *
 * Loads the REAL module over Vite, so what is measured is the code that would ship
 * rather than an inline copy of it. The module imports from `src/vendor/mediabunny.js`,
 * which is the committed bundle — so this also proves the bundle is complete, which an
 * inline `import 'mediabunny'` would not.
 */

import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const PORT = Number(process.env.IU_PROBE_PORT ?? 8099);
const SOURCE = process.argv[2] ?? '/tools/ui/assets/two-audio.mkv';

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto(`http://127.0.0.1:${PORT}/tools/ui/player.html`, { waitUntil: 'load' });

const report = await page.evaluate(async (source) => {
  const mod = await import('/src/viewer/audio-tracks.js');

  const response = await fetch(source);
  const file = new File([await response.arrayBuffer()], 'sample.mkv', { type: 'video/x-matroska' });

  const declared = await mod.listAudioTracks(file);

  // Remux to the SECOND track, then confirm the audible stream actually changed. The
  // tone is the only evidence that counts — reading a flag back is what the Chromium
  // bug was about.
  const startedAt = performance.now();
  const remuxed = await mod.remuxToTrack(file, 1, {
    onProgress: () => {},
  });
  const remuxMs = Math.round(performance.now() - startedAt);

  const url = URL.createObjectURL(remuxed);
  const video = document.createElement('video');
  video.src = url;
  video.style.display = 'none';
  document.body.append(video);

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 8192;
  context.createMediaElementSource(video).connect(analyser);
  analyser.connect(context.destination);
  await video.play().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  let peak = 0;
  let best = -Infinity;
  for (let i = 0; i < bins.length; i += 1) {
    if (bins[i] > best) {
      best = bins[i];
      peak = i;
    }
  }
  const hz = Math.round((peak * context.sampleRate) / analyser.fftSize);
  await context.close();
  video.remove();
  URL.revokeObjectURL(url);

  return {
    apiPresent: mod.audioTracksSupported(),
    inputBytes: file.size,
    declared,
    remuxMs,
    outputBytes: remuxed.size,
    hz,
  };
}, SOURCE);

console.log(JSON.stringify(report, null, 2));
console.log(
  report.hz === 877
    ? 'VERDICT: the module produced a file playing the SECOND track'
    : `VERDICT: wrong tone ${report.hz} Hz — expected 877`,
);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
