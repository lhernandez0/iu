/**
 * With the flag on, does switching audio tracks actually change what you HEAR?
 *
 * Ad-hoc probe. Prints, asserts nothing.
 *
 *   node test/browser/probe-audio-hear-switch.mjs [port]
 *
 * **This is the gap in the earlier flag probe.** That one set `track.enabled` on each
 * entry and read the flags back — which proves the API accepts a write, and proves
 * nothing about the audio. Chromium issue 40663787 is exactly about that gap being a
 * real bug: for years, disabling a track froze the video for 10+ seconds while the
 * audio "kept playing" — the WRONG stream, silently. A flag-readable state that does
 * not change the sound is the failure mode to rule out.
 *
 * Fixed in M138/M139 (June 2025), and the browser under test is 148, so it should be
 * fixed here. Verified rather than assumed: the two tracks are 440 Hz and 880 Hz, so
 * an AnalyserNode says which one is actually being decoded.
 */

import { chromium } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const PORT = Number(process.argv[2] ?? 8099);
const FILE = '/tools/ui/assets/two-audio.mp4';

/** Whether to apply the thread's `currentTime` workaround. */
const useNudge = process.argv.includes('--nudge');

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // The umbrella flag, which is the one a USER can set from chrome://flags.
    '--enable-experimental-web-platform-features',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/tools/ui/player.html`, { waitUntil: 'load' });

const result = await page.evaluate(async ([source, useNudge]) => {
  const video = document.createElement('video');
  video.src = source;
  video.style.display = 'none';
  document.body.append(video);

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 8192;
  context.createMediaElementSource(video).connect(analyser);
  analyser.connect(context.destination);

  /** The dominant frequency right now. */
  const tone = async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
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
    return { hz: Math.round((peak * context.sampleRate) / analyser.fftSize), db: Number(best.toFixed(1)) };
  };

  await video.play().catch(() => {});
  const tracks = video.audioTracks ? [...video.audioTracks] : [];
  const before = await tone();

  const startedAt = Date.now();
  if (tracks.length > 1) {
    // The documented API: exactly one track enabled.
    tracks[0].enabled = false;
    tracks[1].enabled = true;
    // The workaround from the issue thread for the freeze: a nudge to `currentTime`
    // forces the pipeline to rebuild around the new track. Whether it is still needed
    // is the question — M138 fixed the freeze, and this is 148.
    if (useNudge) video.currentTime = video.currentTime;
  }
  const after = await tone();

  // Was the video frozen? The regression this whole issue is about. A 10-second stall
  // is the reported symptom; a small hitch from the seek is expected and fine.
  const timelineAdvanced = video.currentTime > 0;

  const state = {
    trackCount: tracks.length,
    enabled: tracks.map((track) => track.enabled),
    hzBefore: before.hz,
    hzAfter: after.hz,
    switchedHz: before.hz !== after.hz,
    elapsedMs: Date.now() - startedAt,
    timelineAdvanced,
    contextState: context.state,
  };
  await context.close();
  return state;
}, [FILE, useNudge]);

console.log(JSON.stringify(result, null, 2));
console.log(`nudge applied: ${useNudge}`);
console.log(
  result.hzBefore === 441 && result.hzAfter === 877
    ? 'VERDICT: the audible stream really changed (441 Hz -> 877 Hz)'
    : `VERDICT: the audible stream did NOT change as expected (${result.hzBefore} -> ${result.hzAfter})`,
);
await browser.close();
