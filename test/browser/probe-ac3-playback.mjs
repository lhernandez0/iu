/**
 * Can the browser PLAY an AC-3 audio track?
 *
 * Ad-hoc probe. Prints, asserts nothing.
 *
 *   node test/browser/probe-ac3-playback.mjs [port]
 *
 * This is the question that decides whether "make a new file with only the track you
 * want" is a real path or a dead end.
 *
 * WebCodecs `AudioDecoder` refuses AC-3, E-AC-3 and DTS in both browsers — measured.
 * That looked like the end of it. But a `<video>` element is NOT WebCodecs: it has the
 * browser's own demuxer and its own decoder, and those can be licensed differently.
 * Chrome ships AC-3 and E-AC-3 hardware/software decode for the HTML media path.
 *
 * So if the element can play AC-3, then a remux works for EVERY codec the element
 * supports — we would never need to decode anything ourselves, only copy bytes. The
 * WebCodecs measurement would be a red herring.
 *
 * Measures it the only way that counts: play it and look at whether sound comes out.
 * The two tracks are 440 Hz and 880 Hz, so routing through an AnalyserNode says which
 * stream the decoder actually chose — nothing else in the pipeline can fake that.
 */

import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const PORT = Number(process.argv[2] ?? 8099);

/**
 * The dominant frequency of what the element plays, or `null` if it produced nothing.
 *
 * `silent` is reported separately from "could not play", because a decoder that
 * refuses the track and a decoder that outputs silence are different failures and
 * only one of them means the file is unusable.
 */
async function dominantTone(page, url) {
  return page.evaluate(async (source) => {
    const video = document.createElement('video');
    video.src = source;
    video.style.display = 'none';
    document.body.append(video);

    const elementError = await new Promise((resolve) => {
      video.addEventListener('error', () => resolve(`MediaError ${video.error?.code}`), { once: true });
      setTimeout(() => resolve(null), 3000);
    });

    let hz = null;
    let peakDb = null;
    let played = false;
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 8192;
      context.createMediaElementSource(video).connect(analyser);
      analyser.connect(context.destination);
      await video.play().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1200));
      played = !video.paused && video.readyState >= 2;
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
      peakDb = Number(best.toFixed(1));
      await context.close();
    } catch {
      // Capture graph unavailable; the element error is the answer.
    }

    const result = { hz, peakDb, played, silent: peakDb !== null && peakDb < -120, elementError };
    video.remove();
    return result;
  }, url);
}

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/tools/ui/player.html`, { waitUntil: 'load' });

const report = {};
report['references'] = {
  'single-440.mp4 (AAC 440)': await dominantTone(page, '/tools/ui/assets/single-440.mp4'),
  'single-880.mp4 (AAC 880)': await dominantTone(page, '/tools/ui/assets/single-880.mp4'),
};
report['two-track files'] = {
  'two-audio.mp4 (AAC 440 + AAC 880)': await dominantTone(page, '/tools/ui/assets/two-audio.mp4'),
  'aacac3.mp4 (AAC 440 + AC3 880)': await dominantTone(page, '/tools/ui/assets/aacac3.mp4'),
  'aacac3.mkv (AAC 440 + AC3 880)': await dominantTone(page, '/tools/ui/assets/aacac3.mkv'),
};

// **The decisive case.** A file whose ONLY track is the codec in question, so there is
// no working track to fall back to and mask the failure. A 440 Hz AAC reference is
// included first: if that plays and these do not, the codec is the reason.
report['the decisive case'] = {
  'only-ac3.mp4 (AC3 880, the only track)': await dominantTone(page, '/tools/ui/assets/only-ac3.mp4'),
  'only-eac3.mp4 (EAC3 880, the only track)': await dominantTone(page, '/tools/ui/assets/only-eac3.mp4'),
};

console.log(JSON.stringify(report, null, 2));
await browser.close();
