/**
 * Local diagnostics for what the viewer is doing.
 *
 * These used to be console lines. A console line is invisible unless someone is
 * already looking, and it vanishes when the page reloads. They now go to the
 * extension's local log, which the panel exports under Settings > Diagnostics.
 *
 * What is NOT sent: file names, file titles, transcript text, subtitle text, page
 * URLs, cookies, word lookups. The log is for "which step, which codec, which
 * count", not for what the user was reading. File extension, size, codec, cue
 * count and error code are technical facts and are kept.
 *
 * The worker is the only writer of the log. This page sends events to it.
 */

import { MSG, TARGET } from '../common/messages.js';

const api = globalThis.browser ?? globalThis.chrome;

/** @param {'info'|'warn'|'error'} level @param {string} event @param {object} [detail] @param {string|null} [code] */
function report(level, event, detail = {}, code = null) {
  try {
    const sending = api.runtime?.sendMessage?.({
      target: TARGET.BACKGROUND,
      type: MSG.DIAGNOSTIC,
      entry: { level, scope: 'viewer', event, code, detail },
    });
    sending?.catch?.(() => {});
  } catch {
    // Diagnostics must never break playback.
  }
}

const RFC_CODEC = new Map([
  ['aac', 'mp4a.40.2'],
  ['mp3', 'mp4a.40.34'],
  ['ac-3', 'ac-3'],
  ['ac3', 'ac-3'],
  ['eac3', 'ec-3'],
  ['ec-3', 'ec-3'],
  ['opus', 'opus'],
  ['flac', 'flac'],
  ['vorbis', 'vorbis'],
  ['dts', 'dtsc'],
  ['dtsc', 'dtsc'],
  ['pcm-s16', 'l16'],
  ['pcm-s24', 'l24'],
]);

function canPlay(mime) {
  try {
    return document.createElement('video').canPlayType(mime) || 'no';
  } catch {
    return 'threw';
  }
}

function canPlayAudioCodec(codec) {
  const rfc = RFC_CODEC.get(codec);
  if (!rfc) return `(unmapped:${codec})`;
  return canPlay(`video/mp4; codecs="avc1.42E01E,${rfc}"`);
}

const extension = (name) => (String(name).match(/\.[^.]+$/) ?? ['(none)'])[0].toLowerCase().slice(1);

/**
 * Pull a viewer error code out of a message so it reaches the log even when the
 * sentence is what the page shows. Codes are diagnostic data, not UI copy.
 *
 * @param {Record<string, unknown>} fields
 * @returns {string|null}
 */
function codeIn(fields) {
  const text = [fields.error, fields.reason].find((value) => typeof value === 'string');
  return /\b([A-Z]{2,6}\d{3})\b/.exec(text ?? '')?.[1] ?? null;
}

/** A viewer boot event. */
export function logBanner() {
  report('info', 'viewer.boot');
}

/**
 * The file and what the element made of it.
 *
 * @param {File|undefined} file
 * @param {HTMLVideoElement} video
 */
export function logFile(file, video) {
  if (!file) return;
  report('info', 'viewer.file', {
    ext: extension(file.name),
    bytes: file.size,
    type: file.type || undefined,
    readyState: video.readyState,
    networkState: video.networkState,
    ok: !video.error,
    errorCode: video.error?.code,
  });
}

/**
 * Every audio track the container declares, plus the Browser's verdict.
 *
 * @param {Array<{index: number, number: number, codec: string, language: string|null,
 *   channels: number|null, label: string, playable: boolean}>} tracks
 * @param {string} [videoCodec]
 */
export function logAudioTracks(tracks, videoCodec) {
  report('info', 'viewer.audio', { count: tracks.length, codec: videoCodec || undefined });
  for (const track of tracks) {
    const verdict = canPlayAudioCodec(track.codec);
    report('info', 'viewer.audio-track', {
      index: track.index,
      codec: track.codec,
      channels: track.channels ?? undefined,
      playable: track.playable,
      canPlay: verdict,
    });
  }
}

/**
 * A sidecar subtitle file as parsed.
 *
 * @param {{name: string}} file
 * @param {{segments: unknown[], format: string, encoding: string, error: string|null}} parsed
 * @param {string} languageCode
 */
export function logSubtitle(file, parsed, languageCode) {
  report(parsed.error ? 'warn' : 'info', 'viewer.subtitle', {
    ext: extension(file.name),
    bytes: /** @type {{size?: number}} */ (file).size ?? undefined,
    format: parsed.format,
    encoding: parsed.encoding,
    cues: parsed.segments.length,
    ok: !parsed.error,
    // The language code is a technical tag, not the text.
    source: languageCode || undefined,
  });
}

/**
 * The subtitle tracks found inside a container.
 *
 * @param {Array<{number: number, codec: string, kind?: string, language?: string, name?: string|null}>} found
 */
export function logEmbeddedTracks(found) {
  report('info', 'viewer.embedded', { count: found.length });
  for (const track of found) {
    report('info', 'viewer.embedded-track', {
      index: track.number,
      codec: track.codec,
      kind: track.kind ?? undefined,
    });
  }
}

/**
 * A decoder step.
 *
 * @param {string} step
 * @param {Record<string, unknown>} [fields]
 */
export function logDecoder(step, fields = {}) {
  const level = /fail|error|abandon/i.test(step) ? 'error' : 'info';
  report(level, `viewer.decoder.${step}`, fields, codeIn(fields));
}

/**
 * A subtitle-path step.
 *
 * @param {string} step
 * @param {Record<string, unknown>} [fields]
 */
export function logSubs(step, fields = {}) {
  const level = /fail|error/i.test(step) ? 'error' : 'info';
  report(level, `viewer.subs.${step}`, fields, codeIn(fields));
}
