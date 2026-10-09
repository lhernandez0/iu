/**
 * Which audio codecs can WebCodecs decode?
 *
 * Ad-hoc probe. Prints for a person to read, asserts nothing.
 *
 *   node test/browser/probe-audio-codecs.mjs [port]
 *
 * This decides whether "demux the file ourselves and decode the track we want" is a
 * real path or a curiosity. It is only worth doing if the codecs in actual releases
 * can be decoded — and the common ones for a Chinese drama MKV are NOT all AAC.
 *
 * AAC is what the bundled sample carries. AC-3 and E-AC-3 are what a large share of
 * 剧集 rips carry, and DTS/TrueHD beyond that. If those cannot be decoded, a
 * decoder-of-our-own would work on some files and silently not on others.
 */

import { chromium, firefox } from 'playwright';
import { findChrome } from '../../tools/lib/chrome.mjs';

/** The codec strings WebCodecs uses, named the way a person would ask about them. */
const CODECS = [
  ['AAC-LC', 'mp4a.40.2'],
  ['HE-AAC', 'mp4a.40.5'],
  ['MP3', 'mp3'],
  ['Opus', 'opus'],
  ['FLAC', 'flac'],
  ['Vorbis', 'vorbis'],
  ['AC-3', 'ac-3'],
  ['E-AC-3', 'ec-3'],
  ['DTS', 'dtsc'],
  ['DTS-HD', 'dtsh'],
  ['TrueHD', 'mlpa'],
  ['PCM', 'pcm-s16'],
];

async function probe(label, browser) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${process.argv[2] ?? 8099}/tools/ui/player.html`, { waitUntil: 'load' });
  const result = await page.evaluate(async (codecs) => {
    const decoder = globalThis.AudioDecoder;
    if (!decoder) return { supported: false, hasAudioDecoder: false, results: [] };
    const results = [];
    for (const [name, codec] of codecs) {
      const supported = await decoder
        .isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2 })
        .then((s) => Boolean(s.supported))
        .catch(() => false);
      results.push({ name, codec, supported });
    }
    return { supported: true, hasAudioDecoder: true, results };
  }, CODECS);
  console.log(`\n=== ${label} ===`);
  if (!result.hasAudioDecoder) {
    console.log('no AudioDecoder at all');
  } else {
    for (const { name, codec, supported } of result.results) {
      console.log(`  ${name.padEnd(10)} ${codec.padEnd(12)} ${supported ? 'yes' : 'NO'}`);
    }
  }
  await page.close();
}

const c = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
await probe('chromium', c);
await c.close();
const f = await firefox.launch({ headless: true });
await probe('firefox', f);
await f.close();
