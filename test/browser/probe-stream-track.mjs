/**
 * Does the streaming MSE path actually work?
 *
 * Ad-hoc probe. Prints, asserts nothing.
 *
 *   node test/browser/probe-stream-track.mjs [port]
 *
 * `streamTrack` feeds a rebuilt file into a `MediaSource` as the media is produced,
 * instead of collecting the whole thing in memory first. Two things have to be true and
 * neither is obvious:
 *
 *   1. **The init segment must land before any media.** MSE rejects media appended
 *      before the initialisation segment, and the failure is a `SourceBuffer` error
 *      rather than anything descriptive.
 *   2. **The audible stream must change.** The fixture is 440 Hz then 880 Hz, so the
 *      dominant frequency says which track is playing. Reading a flag back would prove
 *      nothing — that is the trap that hid this feature's bugs for six years.
 *
 * It also measures when playback STARTS, which is the entire reason for streaming: the
 * buffered version cannot begin until the whole film is copied.
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
  const mod = await import('/src/reader/audio-tracks.js');

  const response = await fetch(source);
  const file = new File([await response.arrayBuffer()], 'sample.mkv', { type: 'video/x-matroska' });

  const declared = await mod.listAudioTracks(file);

  const startedAt = performance.now();
  const { url, revoke, done } = await mod.streamTrack(file, 1, {});

  // Attach an element and wait for it to be able to play, rather than sleeping.
  const video = document.createElement('video');
  video.src = url;
  video.style.display = 'none';
  document.body.append(video);

  const firstFrameMs = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(-1), 20000);
    video.addEventListener(
      'canplay',
      () => {
        clearTimeout(timer);
        resolve(Math.round(performance.now() - startedAt));
      },
      { once: true },
    );
    video.load();
  });

  let hz = null;
  let silent = null;
  try {
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
    hz = Math.round((peak * context.sampleRate) / analyser.fftSize);
    silent = best < -120;
    await context.close();
  } catch (error) {
    hz = `error: ${error.message}`;
  }

  const state = {
    readyState: video.readyState,
    duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
    playing: !video.paused,
    buffered: video.buffered.length ? Number(video.buffered.end(0).toFixed(2)) : 0,
  };

  // Let production finish so the readout is about the whole stream, not a race.
  const finished = await done.then(() => true).catch((error) => String(error?.message ?? error));

  video.remove();
  revoke();

  return { declared, firstFrameMs, totalMs: Math.round(performance.now() - startedAt), hz, silent, state, finished };
}, SOURCE);

console.log(JSON.stringify(report, null, 2));
console.log(
  report.hz === 877
    ? `VERDICT: streaming works, playing the SECOND track, first frame at ${report.firstFrameMs} ms`
    : `VERDICT: wrong tone ${report.hz} Hz — expected 877`,
);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
