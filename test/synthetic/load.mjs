/**
 * Load the committed synthetic fixtures.
 *
 * The corpus in `test/synthetic/` is our own invented text wearing the shapes of a
 * real capture. It exists because every fixture in this suite used to be written by
 * hand from an idea of what YouTube sends, so the tests could only ever confirm the
 * idea, thirteen bugs were reported from use and not one was found by the suite.
 *
 * Shape comes from `test/fixtures/`, which is real and local. Text is ours, which
 * is what makes the corpus committable. Neither half is useful alone: invented
 * shapes would be the same mistake in a new place, and real text cannot be
 * redistributed and would pin every test to one video.
 *
 * If nothing has been derived yet, the loaders return a small self-contained
 * fallback so the suite still runs on a fresh clone. The fallback is deliberately
 * minimal and clearly marked, it is a bootstrapping aid, not a second source of
 * truth, and a test that depends on its exact contents is a test that will break
 * when someone derives the real corpus.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNTHETIC = join(ROOT, 'test', 'synthetic');

/**
 * Every derived fixture set on disk.
 *
 * @returns {string[]}
 */
export function listSynthetic() {
  if (!existsSync(SYNTHETIC)) return [];
  return readdirSync(SYNTHETIC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SYNTHETIC, entry.name, 'video.json')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * A derived fixture set, or null when nothing has been derived.
 *
 * @param {string} [name] Defaults to the first available set.
 * @returns {{
 *   name: string, video: object, playerResponse: object,
 *   tracks: Array<{languageCode: string, name: string, kind: string|null, isTranslatable: boolean, segments: object[]}>,
 *   shape: object|null, synthetic: boolean
 * }|null}
 */
export function loadSynthetic(name = null) {
  const available = listSynthetic();
  const chosen = name ?? available[0];
  if (!chosen || !available.includes(chosen)) return null;

  const dir = join(SYNTHETIC, chosen);
  const video = JSON.parse(readFileSync(join(dir, 'video.json'), 'utf8'));
  const playerResponse = JSON.parse(readFileSync(join(dir, 'player-response.json'), 'utf8'));

  const tracks = (video.trackList ?? []).map((track) => {
    const file = join(dir, `captions-${track.languageCode}${track.kind === 'asr' ? '-asr' : ''}.json`);
    const body = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { segments: [] };
    return {
      languageCode: track.languageCode,
      name: track.name,
      kind: track.kind ?? null,
      isTranslatable: Boolean(track.isTranslatable),
      segments: body.segments ?? [],
    };
  });

  const shapeFile = join(dir, 'shape-report.json');
  return {
    name: chosen,
    video,
    playerResponse,
    tracks,
    shape: existsSync(shapeFile) ? JSON.parse(readFileSync(shapeFile, 'utf8')) : null,
    // Always true, and stated rather than implied: every fixture here is invented.
    synthetic: true,
  };
}

/**
 * A JSON3 caption body built from a derived track.
 *
 * JSON3 is what the extension actually requests, `fmt=json3` is hard-coded in
 * `buildTrackUrl`, so this is the shape that matters, and it is rebuilt from the
 * real field names (`events`, `tStartMs`, `dDurationMs`, `segs`, `utf8`).
 *
 * `segs` is split into two pieces on some cues on purpose: the real body does that,
 * and a parser that only reads `segs[0]` loses half a line.
 *
 * @param {object[]} segments
 * @param {{splitEvery?: number}} [options]
 * @returns {string}
 */
export function json3From(segments, { splitEvery = 3 } = {}) {
  return JSON.stringify({
    wireMagic: 'pb3',
    events: segments.map((segment, index) => ({
      tStartMs: Math.round(segment.start * 1000),
      dDurationMs: Math.round(segment.duration * 1000),
      segs:
        index % splitEvery === 1 && segment.text.length > 1
          ? [{ utf8: segment.text.slice(0, 1) }, { utf8: segment.text.slice(1) }]
          : [{ utf8: segment.text }],
    })),
  });
}

/**
 * The XML body, which arrives when a track does not support JSON3.
 *
 * Built from the same cues so the two serialisations agree, which is what lets a
 * test assert that both paths produce the same segments.
 *
 * @param {object[]} segments
 * @returns {string}
 */
export function xmlFrom(segments) {
  const cues = segments
    .map((segment) => {
      const text = segment.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `  <text start="${segment.start}" dur="${segment.duration}">${text}</text>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8" ?>\n<transcript>\n${cues}\n</transcript>`;
}

/**
 * A `SUMMARY`-shaped payload, what the content script's `describe` reports.
 *
 * @param {object} fixture From `loadSynthetic`.
 * @param {object} [overrides]
 * @returns {object}
 */
export function summaryFrom(fixture, overrides = {}) {
  return {
    videoId: fixture.video.videoId,
    title: fixture.video.title,
    isLive: Boolean(fixture.video.isLive),
    tracks: fixture.tracks.map((track, index) => ({
      // Real baseUrls carry far more than this; the only part the content script
      // reads back is `lang`, because the stub dispatches on it.
      baseUrl: `https://www.youtube.com/api/timedtext?v=${fixture.video.videoId}&lang=${track.languageCode}&fmt=srv3`,
      languageCode: track.languageCode,
      name: track.name,
      kind: track.kind,
      isTranslatable: track.isTranslatable,
      vssId: track.kind === 'asr' ? `a.${track.languageCode}` : `.${track.languageCode}`,
      _index: index,
    })),
    translationLanguages: fixture.video.translationLanguages ?? [],
    innertubeApiKey: 'KEY',
    ...overrides,
  };
}

/**
 * The fallback used when nothing has been derived.
 *
 * Small, self-contained, and obviously synthetic. It exists so a fresh clone can
 * run `npm test`, not so tests can depend on it, anything asserting an exact cue
 * here would break the moment the real corpus is derived, which is the wrong
 * direction of dependency.
 */
export const FALLBACK = {
  name: 'fallback',
  synthetic: true,
  shape: null,
  video: {
    videoId: 'syntheticfallback',
    title: 'Fallback fixture (no synthetic corpus derived yet)',
    isLive: false,
    trackList: [
      { languageCode: 'zh-Hans', name: 'Chinese (Simplified)', kind: null, isTranslatable: true },
      { languageCode: 'en', name: 'English', kind: null, isTranslatable: true },
    ],
    translationLanguages: [
      { languageCode: 'en', name: 'English' },
      { languageCode: 'ja', name: 'Japanese' },
    ],
  },
  playerResponse: null,
  tracks: [
    {
      languageCode: 'zh-Hans',
      name: 'Chinese (Simplified)',
      kind: null,
      isTranslatable: true,
      segments: [
        { start: 37.933, duration: 1.333, text: '大家好' },
        { start: 39.4, duration: 1.77, text: '今天天气很好' },
        { start: 41.3, duration: 2.4, text: '我们出去走走' },
      ],
    },
    {
      languageCode: 'en',
      name: 'English',
      kind: null,
      isTranslatable: true,
      segments: [
        { start: 37.933, duration: 1.333, text: 'Hello everyone' },
        { start: 39.4, duration: 1.77, text: 'Nice weather today' },
        { start: 41.3, duration: 2.4, text: 'Let us go for a walk' },
      ],
    },
  ],
};

/**
 * The derived fixture if there is one, otherwise the fallback.
 *
 * @returns {object}
 */
export function fixture() {
  return loadSynthetic() ?? FALLBACK;
}
