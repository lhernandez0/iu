/**
 * What can the ELEMENT play? (`canPlayType` per codec, per container.)
 *
 * Ad-hoc probe. Prints, asserts nothing.
 *
 *   node test/browser/probe-canplaytype.mjs [port]
 *
 * This is the question that actually decides the remux path, and it is a DIFFERENT
 * question from the WebCodecs one.
 *
 * `AudioDecoder` refusing AC-3 means we cannot decode it ourselves. It says nothing
 * about whether the `<video>` ELEMENT can play it, because that uses the browser's own
 * demuxer and its own decoders — which are licensed per platform and are not the same
 * thing as WebCodecs.
 *
 * Remuxing does not decode anything. It copies bytes. So a codec only needs to be
 * playable, never decodable-by-us. If the element can play AC-3 here, the remux path
 * covers it and the WebCodecs finding is irrelevant to it.
 *
 * `canPlayType` is answered from the same probing Chrome itself runs before attempting
 * playback, so the "" / "maybe" / "probably" strings are the browser's own verdict.
 */

import { chromium, firefox } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

const CASES = [
  ['AAC in MP4', 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"'],
  ['AC-3 in MP4', 'video/mp4; codecs="avc1.4d401e, ac-3"'],
  ['E-AC-3 in MP4', 'video/mp4; codecs="avc1.4d401e, ec-3"'],
  ['AC-3 in MKV', 'video/x-matroska; codecs="avc1.4d401e, ac-3"'],
  ['AC-3 bare', 'audio/mp4; codecs="ac-3"'],
  ['E-AC-3 bare', 'audio/mp4; codecs="ec-3"'],
  ['DTS bare', 'audio/mp4; codecs="dtsc"'],
  ['Opus', 'audio/webm; codecs="opus"'],
  ['FLAC', 'audio/ogg; codecs="flac"'],
  ['MP3', 'audio/mpeg'],
];

async function probe(label, browser, extra = []) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${process.argv[2] ?? 8099}/tools/ui/player.html`, { waitUntil: 'load' });
  const rows = await page.evaluate((cases) => {
    const el = document.createElement('video');
    const audio = document.createElement('audio');
    return cases.map(([name, type]) => ({
      name,
      verdict: el.canPlayType(type) || audio.canPlayType(type) || '',
    }));
  }, CASES);
  console.log(`\n=== ${label} ${extra.join(' ')} ===`);
  for (const { name, verdict } of rows) {
    const shown = verdict === '' ? '(no)' : verdict;
    console.log(`  ${name.padEnd(16)} ${shown}`);
  }
  await page.close();
}

const chromiumBrowser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
const version = chromiumBrowser.version();
await probe('Chrome for Testing', chromiumBrowser);
await chromiumBrowser.close();

// Same binary, patent-checked codecs forced ON. If AC-3 appears here and not above, the
// codec is a licensing/build switch rather than a platform gap — which decides whether
// it is worth worrying about for users on other builds.
const forced = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-features=PlatformHEVCDecoderSupport',
    '--enable-proprietary-codecs',
    '--enable-features=Ac3Eac3',
  ],
});
await probe('Chrome for Testing + proprietary flags', forced, [`(${version})`]);
await forced.close();

const firefoxBrowser = await firefox.launch({ headless: true });
await probe('Firefox', firefoxBrowser);
await firefoxBrowser.close();
