/**
 * Console diagnostics for what a file actually contains.
 *
 * **Temporary, and deliberately loud.** `WIDELY_PLAYABLE` in `audio-tracks.js` is a
 * static allowlist used to warn that a file's audio may not decode, and it is a
 * guess: AC-3 plays in Chrome on Windows and not in Chromium on Linux, and this
 * list cannot see which build it is running on. The `UNKNOWN` and `AC3` messages
 * users have reported are that guess firing, and there is no way to tell a correct
 * warning from a false one without seeing the files.
 *
 * So this logs the raw facts and nothing else, in one block per file, under a
 * single prefix so a user can paste back just the relevant lines:
 *
 *   1. Open the viewer, open the file, look at the console.
 *   2. Filter for `[iu]`.
 *   3. Paste the result into the issue.
 *
 * One block per file rather than a line per fact, because the interaction between a
 * container, its tracks and the Browser's own answer is the thing being diagnosed,
 * and those are only meaningful together.
 *
 * ## What it does NOT log
 *
 * Never the file's `name` beyond what the viewer already shows, never its bytes,
 * and never a URL. A container's internal tags can carry anything (a `TITLE` tag can
 * be a release name), so tags are summarised by KEY and count rather than dumped.
 * This is a privacy-respecting extension and a diagnostic must not be the thing that
 * leaks, which is also why nothing here is sent anywhere: it is `console.log`, and
 * the user decides what to share.
 */

const PREFIX = '[iu]';

/**
 * Map a container's short codec name to the RFC 6381 string `canPlayType` wants.
 *
 * **This matters, and getting it wrong is how this diagnostic lied.** Asked with the
 * container's own spelling, `canPlayType('video/mp4; codecs="avc1.42E01E,aac"')`
 * answers `""` (a refusal), because `aac` is not a valid codec parameter: the RFC
 * spelling is `mp4a.40.2`. So a naive probe reports that nothing is playable,
 * including files that play perfectly. Measured: `aac` -> `""`, `mp4a.40.2` ->
 * `"probably"`, same browser, same moment.
 *
 * A short name with no entry is reported as `(unmapped)` rather than guessed, so an
 * empty answer is legible as a gap in this table instead of a verdict on the codec.
 */
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

/**
 * Is `canPlayType` willing to say yes?
 *
 * The Browser's own opinion, which is the ONLY authority on whether a codec will
 * actually decode. The static allowlist in `audio-tracks.js` exists because
 * `canPlayType` answers "maybe" for containers it cannot fully predict, so both
 * answers are worth seeing side by side.
 *
 * @param {string} mime
 * @returns {string}
 */
function canPlay(mime) {
  try {
    return document.createElement('video').canPlayType(mime) || 'no';
  } catch {
    return 'threw';
  }
}

/**
 * Ask `canPlayType` properly, in the RFC spelling.
 *
 * @param {string} codec The container's short name.
 * @returns {string}
 */
function canPlayAudioCodec(codec) {
  const rfc = RFC_CODEC.get(codec);
  if (!rfc) return `(unmapped:${codec})`;
  return canPlay(`video/mp4; codecs="avc1.42E01E,${rfc}"`);
}

/** @param {string} label @param {Record<string, unknown>} fields */
function line(label, fields) {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`);
  console.log(`${PREFIX} ${label} ${parts.join(' ')}`);
}

/**
 * Log the video FILE and what the element made of it.
 *
 * `videoWidth`/`duration` are the element's own decode result, so a non-zero size
 * here means the container and its VIDEO codec were accepted, which is what makes
 * an audio-only complaint believable. Called from the `loadedmetadata` handler.
 *
 * @param {File|undefined} file
 * @param {HTMLVideoElement} video
 */
export function logFile(file, video) {
  if (!file) return;
  console.log(`${PREFIX} --- file ---`);
  line('file', {
    type: file.type || '(none)',
    bytes: file.size,
    ext: (file.name.match(/\.[^.]+$/) ?? ['(none)'])[0].toLowerCase(),
  });
  line('element', {
    readyState: video.readyState,
    networkState: video.networkState,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    duration: Number.isFinite(video.duration) ? video.duration.toFixed(2) : String(video.duration),
    error: video.error ? `${video.error.code}:${video.error.message || 'no message'}` : 'none',
  });
}

/**
 * Log every audio track the container declares, plus the Browser's verdict on each.
 *
 * The two facts that decide the `UNKNOWN` and `AC3` messages: the codec STRING as the
 * container spells it, and whether `canPlayType` agrees with `WIDELY_PLAYABLE`. When
 * they disagree, the warning is wrong and this is what shows it.
 *
 * @param {Array<{index: number, number: number, codec: string, language: string|null,
 *   channels: number|null, label: string, playable: boolean}>} tracks
 * @param {string} [videoCodec]
 */
export function logAudioTracks(tracks, videoCodec) {
  console.log(`${PREFIX} --- audio ---`);
  line('audioTracks', { count: tracks.length, videoCodec: videoCodec || '(not read here)' });
  for (const track of tracks) {
    const verdict = canPlayAudioCodec(track.codec);
    line('audio', {
      i: track.index,
      codec: track.codec,
      lang: track.language,
      ch: track.channels,
      // What `audio-tracks.js` will use to decide whether to warn.
      allowlisted: track.playable,
      // What the browser says when asked PROPERLY. When these disagree, the warning
      // is wrong, which is the whole reason for logging both.
      canPlayType: verdict,
      agree: String(track.playable === (verdict !== 'no' && !verdict.startsWith('('))),
    });
  }
}

/**
 * Log a subtitle FILE as parsed, which is where a sidecar goes wrong.
 *
 * `cues` and `error` together say whether the file was understood; `encoding` is
 * worth logging because a Chinese `.srt` is very often GBK and decoding it as UTF-8
 * yields replacement characters that parse cleanly into garbage.
 *
 * @param {{name: string}} file
 * @param {{segments: unknown[], format: string, encoding: string, error: string|null}} parsed
 * @param {string} languageCode
 */
export function logSubtitle(file, parsed, languageCode) {
  console.log(`${PREFIX} --- subtitle ---`);
  line('subtitle', {
    ext: (file.name.match(/\.[^.]+$/) ?? ['(none)'])[0].toLowerCase(),
    bytes: /** @type {{size?: number}} */ (file).size ?? '(n/a)',
    detected: parsed.format,
    encoding: parsed.encoding,
    cues: parsed.segments.length,
    language: languageCode,
    error: parsed.error ?? 'none',
    first: parsed.segments[0]?.text ? JSON.stringify(String(parsed.segments[0].text).slice(0, 24)) : '(none)',
  });
}

/**
 * Log the subtitle tracks found INSIDE a container.
 *
 * Image-based subtitles (PGS, VobSub) are the common surprise here: they are real
 * tracks with no text in them, so they appear in the list and can never be read.
 *
 * @param {Array<{number: number, codec: string, kind?: string, language?: string, name?: string|null}>} found
 */
export function logEmbeddedTracks(found) {
  console.log(`${PREFIX} --- embedded ---`);
  line('embeddedTracks', { count: found.length });
  for (const track of found) {
    line('embedded', {
      n: track.number,
      codec: track.codec,
      kind: track.kind ?? '(none)',
      lang: track.language ?? '(none)',
      title: track.name ? JSON.stringify(track.name.slice(0, 24)) : '(none)',
    });
  }
}

/**
 * What the decoder attempt is doing, logged at each step.
 *
 * This exists because "I hear nothing and there is no selector" has several possible
 * causes and no way to tell them apart from outside: the capability probe said no, the
 * import failed, the demux threw, the decode produced silence, or nothing ran at all.
 * Each step logs, so the answer is in the paste rather than in a round trip.
 *
 * @param {string} step
 * @param {Record<string, unknown>} [fields]
 */
export function logDecoder(step, fields = {}) {
  line('decoder', { step, ...fields });
}

/** Announce once per page, so a pasted log says which build it came from. */
export function logBanner() {
  line('viewer', {
    ua: navigator.userAgent,
    audioTracksApi: 'audioTracks' in HTMLMediaElement.prototype,
    // The codecs users have reported being warned about. Asked in the RFC spelling,
    // because the short name answers `""` for everything and would report this browser
    // as unable to play anything at all.
    canPlayAc3: canPlayAudioCodec('ac-3'),
    canPlayEac3: canPlayAudioCodec('ec-3'),
    canPlayDts: canPlayAudioCodec('dts'),
    canPlayAac: canPlayAudioCodec('aac'),
  });
}
