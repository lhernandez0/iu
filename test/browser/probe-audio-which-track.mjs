/**
 * Which audio track does Chrome actually PLAY?
 *
 * Ad-hoc probe. Prints for a person to read, asserts nothing.
 *
 *   node test/browser/probe-audio-which-track.mjs [port]
 *
 * ## Why this matters
 *
 * `audioTracks` is flagged off, which rules out the API. It does NOT rule out
 * controlling which stream plays: a workable alternative is to hand the video a blob
 * that contains only the track you want, so there is nothing to switch between. That
 * only helps if Chrome plays a PREDICTABLE track out of a multi-track file, so the
 * first question is which one it picks.
 *
 * Measures it rather than assuming: the two tracks are 440 Hz and 880 Hz sine tones,
 * so routing playback through an AnalyserNode and finding the dominant frequency says
 * which stream the decoder selected. Nothing else in the pipeline can fake that.
 */

import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const PORT = Number(process.argv[2] ?? 8099);

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/tools/ui/player.html`, { waitUntil: 'load' });

/**
 * The dominant frequency of what the element is playing, in Hz.
 *
 * `0` with a very low mean level means silence, which is a different result from
 * "no tone detected" — headless Chrome may have no output device at all, so the two
 * are worth telling apart rather than both reading as failure.
 *
 * @param {string} url
 */
async function dominantTone(url) {
  return page.evaluate(async (source) => {
    const video = document.createElement('video');
    video.src = source;
    video.crossOrigin = 'anonymous';
    video.style.display = 'none';
    document.body.append(video);

    const context = new AudioContext();
    const stream = context.createMediaElementSource(video);
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    stream.connect(analyser);
    analyser.connect(context.destination);

    await video.play().catch(() => {});
    // Long enough for the first buffers to decode and reach the analyser.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);

    let peak = 0;
    let peakValue = -Infinity;
    let total = 0;
    for (let i = 0; i < bins.length; i += 1) {
      total += bins[i];
      if (bins[i] > peakValue) {
        peakValue = bins[i];
        peak = i;
      }
    }

    const hz = (peak * context.sampleRate) / analyser.fftSize;
    const result = {
      hz: Math.round(hz),
      peakDb: Number(peakValue.toFixed(1)),
      meanDb: Number((total / bins.length).toFixed(1)),
      silent: peakValue < -120,
      contextState: context.state,
      videoVolume: video.volume,
      videoMuted: video.muted,
      readyState: video.readyState,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : String(video.duration),
    };
    video.remove();
    await context.close();
    return result;
  }, url);
}

const report = {};
for (const file of ['two-audio.mp4', 'single-440.mp4', 'single-880.mp4']) {
  report[file] = await dominantTone(`/tools/ui/assets/${file}`);
}

console.log(JSON.stringify(report, null, 2));
await browser.close();
