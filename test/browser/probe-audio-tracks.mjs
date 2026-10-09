/**
 * Can the reader offer an AUDIO TRACK selector?
 *
 * Ad-hoc probe. Prints for a person to read, asserts nothing, so it is not part of
 * `npm test`.
 *
 *   node test/browser/probe-audio-tracks.mjs [port]
 *
 * ## What this establishes, measured rather than assumed
 *
 * 1. Chrome 148 and Firefox 155 BOTH play a local file with two audio tracks, and
 *    NEITHER exposes any API for choosing between them. `audioTracks`,
 *    `webkitAudioTracks`, `videoTracks`, `setAudioTrack` — none exists, and there
 *    is no same-named successor hiding in the prototype.
 *
 * 2. Both DO expose MediaSource, WebCodecs `AudioDecoder`, and AAC decode. So the
 *    videos were decodable; it is selection that is missing, not playback.
 *
 *    This distinction matters and is the whole point of the probe. ADR 0009
 *    records the lesson that "'there is no API for this' is not the same as 'this
 *    is impossible'" — both halves of which were true here. There is no API. And
 *    it is not impossible: demuxing the file and feeding a chosen track through
 *    MediaSource would work. The constraint is cost, not capability, and the docs
 *    should say which.
 *
 * 3. The MP4 case is worse than the MKV case: an MP4 puts its track descriptors in
 *    a `moov` box built from AVC/ISO-BMFF framing in a whole separate format, so
 *    the Matroska parser cannot reach them. MKV only needs `parseTracks` to stop
 *    discarding non-subtitle entries.
 */

import { chromium, firefox } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const PORT = Number(process.argv[2] ?? 8099);
const FILES = ['two-audio.mp4', 'two-audio.mkv'];

/** The API surface, per browser, per container. */
async function inventory(page, file) {
  await page.goto(`http://127.0.0.1:${PORT}/tools/ui/player.html?src=/tools/ui/assets/${file}`, {
    waitUntil: 'load',
  });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const video = document.querySelector('video');
    const proto = Object.getOwnPropertyNames(HTMLMediaElement.prototype);
    return {
      file: new URLSearchParams(location.search).get('src').split('/').pop(),
      plays: video.readyState >= 3 && !video.error,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : String(video.duration),
      error: video.error ? `MediaError ${video.error.code}` : null,
      audioSelectionApi: proto.filter((key) => /audio/i.test(key)),
      audioTracks: 'audioTracks' in video,
      webkitAudioTracks: 'webkitAudioTracks' in video,
      mediaSource: typeof globalThis.MediaSource,
      audioDecoder: typeof globalThis.AudioDecoder,
    };
  });
}

const chromiumBrowser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const firefoxBrowser = await firefox.launch({ headless: true });

const report = {};
for (const [name, browser] of [['chromium', chromiumBrowser], ['firefox', firefoxBrowser]]) {
  const page = await browser.newPage();
  report[name] = { version: await page.evaluate(() => navigator.userAgent.match(/(Chrome|Firefox)\/[\d.]+/)?.[0]) };
  for (const file of FILES) report[name][file] = await inventory(page, file);
  await page.close();
  await browser.close();
}

console.log(JSON.stringify(report, null, 2));
