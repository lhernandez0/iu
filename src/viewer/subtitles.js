/**
 * Subtitle file parsing — SRT, WebVTT and ASS/SSA into `{ start, duration, text }`.
 *
 * Pure functions over text, no DOM and no chrome API, so the hermetic suite can
 * drive them directly and the viewer page is only wiring. That split is
 * deliberate: this is where the correctness risk lives, and it should be
 * testable without a browser.
 *
 * The output shape is the one the rest of the extension already deals in — the
 * same `{ start, duration, text }` the YouTube content script returns. Nothing
 * downstream knows or cares that these came from a file, which is what lets the
 * panel, the word marking and the alignment stay untouched.
 *
 * @typedef {Object} Segment
 * @property {number} start    Seconds from the beginning.
 * @property {number} duration Seconds. 0 when unknown.
 * @property {string} text
 */

/** How many bytes to sniff before giving up and assuming UTF-8. */
const ENCODING_SNIFF_BYTES = 4096;

/**
 * Encoding candidates, in the order they are tried.
 *
 * **This is the most important detail in the file.** Chinese subtitle files are
 * very often GBK and Japanese ones Shift-JIS, and decoding either as UTF-8 does
 * not throw — it substitutes U+FFFD, which parses *perfectly* into a transcript
 * of garbage. That is the worst failure shape available: everything looks like it
 * worked, and a learner sees a page of replacement characters with no error
 * anywhere.
 *
 * So UTF-8 is tried with `fatal: true`, which makes the decoder THROW on invalid
 * bytes instead of substituting. A wrong guess then becomes a branch we can take
 * rather than a silent corruption. `utf-8` is first because it is the common case
 * and the only one the web formats guarantee.
 */
const ENCODING_CANDIDATES = ['utf-8', 'gbk', 'shift_jis', 'big5', 'windows-1252'];

/**
 * Decode bytes to text, detecting the encoding rather than assuming it.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {{text: string, encoding: string, error: string|null}}
 */
export function decodeSubtitles(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  // A BOM settles it outright, and is the one case where detection is certain.
  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(view.subarray(3)), encoding: 'utf-8', error: null };
  }
  if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(view.subarray(2)), encoding: 'utf-16le', error: null };
  }
  if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(view.subarray(2)), encoding: 'utf-16be', error: null };
  }

  for (const encoding of ENCODING_CANDIDATES) {
    try {
      // `fatal` only for utf-8: the legacy decoders have no equivalent, and a
      // wrong one of those produces replacement characters rather than throwing.
      // That is why utf-8 strictness matters most — it is the case where a
      // confident wrong answer is most likely.
      const fatal = encoding === 'utf-8';
      const text = new TextDecoder(encoding, { fatal }).decode(view);
      // A legacy decoder that produced replacement characters is not a fit worth
      // returning when a later candidate might be clean.
      if (encoding !== 'utf-8' && text.includes('\uFFFD')) continue;
      return { text, encoding, error: null };
    } catch {
      // Not this one. Try the next.
    }
  }

  // Everything failed, so return the least-bad answer with the fault named rather
  // than pretending the text is fine.
  return {
    text: new TextDecoder('utf-8').decode(view),
    encoding: 'utf-8',
    error: 'the text encoding was not recognised',
  };
}

/**
 * Which format a file is, from its content rather than its extension.
 *
 * Extension lies often enough here — `.srt` files that are really ASS, `.ass`
 * files that are SRT — that sniffing the body is more reliable and costs one
 * `startsWith`.
 *
 * @param {string} text
 * @returns {'vtt'|'ass'|'srt'|null}
 */
export function detectFormat(text) {
  const head = text.slice(0, ENCODING_SNIFF_BYTES);
  // Leading whitespace and a BOM are both common; `trimStart` handles both.
  const trimmed = head.replace(/^\uFEFF/, '').trimStart();

  if (/^WEBVTT\b/.test(trimmed)) return 'vtt';
  // Any of the three ASS section headers, not just the first one. A real ASS file
  // always opens with `[Script Info]`, but a file that has been trimmed or
  // hand-edited may not — and requiring the first header specifically means such
  // a file falls through to `null` and reports "unrecognised format" for
  // something the parser would have read perfectly. `[Events]` is the block that
  // actually carries cues, so it is the more truthful marker of the two.
  if (/^\[Script Info\]/m.test(trimmed)) return 'ass';
  if (/^\[V4\+? Styles\]/m.test(trimmed)) return 'ass';
  if (/^\[Events\]/m.test(trimmed)) return 'ass';
  if (/-->/.test(trimmed)) return 'srt';
  return null;
}

/**
 * `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` to seconds.
 *
 * SRT uses a comma and WebVTT a dot, and both appear in the wild with the other
 * separator. Hours are optional in practice even though the formats say
 * otherwise, so they are parsed as optional rather than required.
 *
 * @param {string} stamp
 * @returns {number} Seconds, or NaN when unparseable.
 */
export function parseTimestamp(stamp) {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(stamp.trim());
  if (!match) return NaN;
  const [, hours, minutes, seconds, fraction] = match;
  // Milliseconds may be written with 1, 2 or 3 digits — `.5` is half a second,
  // not 5ms. Padding to three is what makes that distinction.
  const ms = Number(fraction.padEnd(3, '0'));
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + ms / 1000;
}

/**
 * Parse an SRT file.
 *
 * @param {string} text
 * @returns {Segment[]}
 */
function parseSrt(text) {
  const segments = [];
  // Blocks are separated by a blank line. `\r?\n` throughout because CRLF files
  // are common and a stray `\r` ends up inside the text otherwise.
  for (const block of text.replace(/^\uFEFF/, '').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line, index) => !(index === 0 && /^\d+$/.test(line.trim())));
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing === -1) continue;

    const [rawStart, rawEnd] = lines[timing].split('-->');
    const start = parseTimestamp(rawStart ?? '');
    const end = parseTimestamp((rawEnd ?? '').trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(start)) continue;

    const body = lines.slice(timing + 1).join('\n').trim();
    if (!body) continue;

    segments.push({ start, duration: Number.isFinite(end) ? Math.max(0, end - start) : 0, text: body });
  }
  return segments;
}

/**
 * Parse a WebVTT file.
 *
 * Close enough to SRT to share the timing parser, different enough in three ways
 * that matter: cue settings hang off the end of the timing line, cues may be
 * named, and inline tags like `<c.yellow>` and `<00:00:01.000>` are markup rather
 * than words.
 *
 * @param {string} text
 * @returns {Segment[]}
 */
function parseVtt(text) {
  const segments = [];
  const body = text.replace(/^\uFEFF/, '').replace(/^WEBVTT[^\n]*\n/, '');

  for (const block of body.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (!lines.length) continue;
    // NOTE, STYLE and REGION blocks are metadata, never cues.
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0].trim())) continue;

    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing === -1) continue;

    const [rawStart, rest] = lines[timing].split('-->');
    // Everything after the end timestamp on that line is cue settings
    // (`position:50% align:middle`), not part of the time.
    const endStamp = (rest ?? '').trim().split(/\s+/)[0] ?? '';
    const start = parseTimestamp(rawStart ?? '');
    const end = parseTimestamp(endStamp);
    if (!Number.isFinite(start)) continue;

    const text = stripInlineTags(lines.slice(timing + 1).join('\n')).trim();
    if (!text) continue;

    segments.push({ start, duration: Number.isFinite(end) ? Math.max(0, end - start) : 0, text });
  }
  return segments;
}

/**
 * Remove WebVTT inline markup, keeping the words.
 *
 * `<c.classname>`, `<v Speaker>`, `<b>` and the bare `<00:00:01.000>` cue
 * timestamps are all markup. Leaving them in would put angle brackets in the
 * transcript and break the word segmenter on every line.
 *
 * @param {string} text
 * @returns {string}
 */
function stripInlineTags(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Remove ASS/SSA override and drawing tags, keeping the words.
 *
 * ASS is a *styled* format and we deliberately discard the styling: position,
 * colour and karaoke timing are all about how the text should look, and the panel
 * decides that itself. What must survive is the text, which in ASS is wrapped in
 * `{\...}` blocks and separated by `\N` hard breaks.
 *
 * Covered because they all appear in real files:
 *   `{\pos(320,240)}`  positioning
 *   `{\an8}`           alignment
 *   `{\k50}` `{\K50}`  karaoke timing
 *   `{\fad(500,500)}`  fades
 *   `{\b1}` `{\i1}`    bold/italic
 *   `{\p1}...{\p0}`    drawing commands (no text at all)
 *
 * @param {string} text
 * @returns {string}
 */
function stripAssTags(text) {
  return (
    text
      // A drawing block contains vector commands, not words. Drop it entirely
      // rather than letting coordinates through as text.
      .replace(/\{\\p\d+\}[\s\S]*?\{\\p0\}/g, '')
      // Every other override block is pure styling.
      .replace(/\{[^}]*\}/g, '')
      // `\N` and `\n` are hard and soft line breaks in ASS.
      .replace(/\\N/g, '\n')
      .replace(/\\n/g, ' ')
      .replace(/\\h/g, ' ')
      .trim()
  );
}

/**
 * Parse an ASS/SSA file.
 *
 * The `Dialogue:` lines carry the cues and the `Format:` line above them says
 * which comma-separated field is which. That indirection cannot be skipped by
 * splitting on commas and taking a fixed index: files vary in field order and
 * count, and the `Text` field — the last one by spec, but not always in practice
 * — legitimately CONTAINS commas, so a naive split would truncate every line at
 * its first comma.
 *
 * @param {string} text
 * @returns {Segment[]}
 */
function parseAss(text) {
  const segments = [];
  let inEvents = false;
  /** @type {string[]} */
  let fields = [];

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^\[/.test(line)) {
      inEvents = /^\[Events\]/i.test(line);
      continue;
    }
    // `;` is the ASS comment character.
    if (!inEvents || line.startsWith(';')) continue;

    if (/^Format\s*:/i.test(line)) {
      fields = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((name) => name.trim().toLowerCase());
      continue;
    }

    if (!/^Dialogue\s*:/i.test(line)) continue;

    // Split on the first N-1 commas, so the final field keeps any commas it
    // holds. Done by walking rather than split/join, which is clearer about the
    // intent and avoids rebuilding the string.
    const payload = line.slice(line.indexOf(':') + 1);
    const parts = payload.split(',');
    const textIndex = fields.indexOf('text');
    // With no Format line the spec order is assumed; `Text` is last.
    const keep = textIndex === -1 ? parts.length - 1 : textIndex;
    const head = parts.slice(0, keep);
    const body = parts.slice(keep).join(',');

    const at = (name) => {
      const index = fields.indexOf(name);
      return index === -1 ? '' : (head[index] ?? '');
    };

    const start = parseAssTime(at('start'));
    const end = parseAssTime(at('end'));
    if (!Number.isFinite(start)) continue;

    const clean = stripAssTags(body)
      // A single line break reads better than two in the panel's row model.
      .replace(/\n{2,}/g, '\n');
    if (!clean) continue;

    segments.push({ start, duration: Number.isFinite(end) ? Math.max(0, end - start) : 0, text: clean });
  }

  return segments;
}

/**
 * `h:mm:ss.cc` to seconds.
 *
 * ASS uses a SINGLE-digit hour and a two-digit hundredth, which is why this
 * cannot share `parseTimestamp` — that would read `0:02:40.65` as 2 minutes 40
 * seconds and 650ms, when it is 2 seconds and 65 centiseconds of a minute's field.
 * Getting this wrong shifts every line by an order of magnitude, so it is a
 * separate function with its own tests rather than a flag on the other one.
 *
 * @param {string} stamp
 * @returns {number} Seconds, or NaN.
 */
function parseAssTime(stamp) {
  const match = /^\s*(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*$/.exec(stamp ?? '');
  if (!match) return NaN;
  const [, hours, minutes, seconds, fraction] = match;
  const ms = Number(fraction.padEnd(3, '0').slice(0, 3));
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + ms / 1000;
}

/**
 * Parse a subtitle file of any supported kind, from bytes.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {string} [fileName] Used only to name the format in an error.
 * @returns {{segments: Segment[], format: string|null, encoding: string, error: string|null}}
 */
export function parseSubtitles(bytes, fileName = '') {
  const { text, encoding, error: encodingError } = decodeSubtitles(bytes);
  const format = detectFormat(text);

  if (!format) {
    return {
      segments: [],
      format: null,
      encoding,
      error:
        encodingError ??
        `could not tell what format${fileName ? ` ${fileName}` : ''} is — expected SRT, WebVTT or ASS`,
    };
  }

  const segments = format === 'srt' ? parseSrt(text) : format === 'vtt' ? parseVtt(text) : parseAss(text);
  segments.sort((a, b) => a.start - b.start);

  if (!segments.length) {
    // Parsing succeeded and produced nothing. That is a distinct outcome from an
    // unknown format, and worth its own message: a subtitle file with no cues is
    // usually the wrong file, not a broken one.
    return { segments, format, encoding, error: encodingError ?? 'that file has no subtitle cues in it' };
  }

  return { segments, format, encoding, error: encodingError };
}

/**
 * A language code from a subtitle filename, since a sidecar file carries none.
 *
 * The formats have no language metadata field, so the convention in the wild is
 * the filename: `film.zh-Hans.srt`, `film.zho.srt`, `film.en.srt`. When nothing
 * recognisable is present the answer is `und` — undetermined — rather than a
 * guess, because guessing English for a Japanese film marks it with the wrong
 * word list and looks like a bug in the marking rather than in the guess.
 *
 * @param {string} fileName
 * @returns {string} A BCP-47-ish code, or `und`.
 */
export function languageFromFileName(fileName) {
  const stem = String(fileName).replace(/\.[^.]+$/, '');
  // Split on `.`, `_` and spaces but NOT hyphens: `zh-Hans` is one language tag,
  // and splitting it would hand back `zh` and throw away the script — which is
  // the difference between Simplified and Traditional, i.e. between marking a
  // Simplified subtitle with the right word list and the wrong one.
  const parts = stem.split(/[._ ]+/).filter(Boolean);

  // Walk from the end so `film.2024.zh-Hans` reads the language and not `2024`.
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts[i];
    if (LANGUAGE_CODES.has(candidate.toLowerCase())) return normaliseLanguage(candidate);

    // The language may be hyphen-joined to something else — `movie-zh`,
    // `film-zh-Hans` — so fall back to the sub-parts before giving up. Tested
    // from the end first, because the language is nearer the extension in the
    // conventions that use this form.
    if (!candidate.includes('-')) continue;
    for (const sub of candidate.split('-').filter(Boolean).reverse()) {
      if (LANGUAGE_CODES.has(sub.toLowerCase())) return normaliseLanguage(sub);
    }
  }
  return 'und';
}

/** Normalise to the casing the rest of the extension expects: `zh-Hans`. */
function normaliseLanguage(code) {
  const lower = code.toLowerCase();
  if (lower.length === 2) return lower;
  const [base, ...rest] = lower.split('-');
  return [base, ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1))].join('-');
}

/**
 * Language tags we recognise in a filename.
 *
 * Both the ISO 639-1 two-letter codes and the ISO 639-2/B three-letter ones,
 * because subtitle archives use both interchangeably — `.zh.srt` and `.zho.srt`
 * are the same language and both are everywhere. Deliberately not a complete ISO
 * registry: a filename `film.abc.srt` is far more likely to be a release tag than
 * a language, and a false positive would choose the wrong word list.
 */
const LANGUAGE_CODES = new Set([
  // Chinese
  'zh', 'zho', 'chi', 'cmn', 'yue', 'zh-hans', 'zh-hant', 'zh-cn', 'zh-tw', 'chs', 'cht', 'sc', 'tc',
  // Japanese
  'ja', 'jpn',
  // Korean
  'ko', 'kor',
  // Romance and Germanic, for the gloss line
  'en', 'eng', 'eng-us', 'eng-gb', 'es', 'spa', 'fr', 'fra', 'fre', 'de', 'deu', 'ger',
  'it', 'ita', 'pt', 'por', 'pt-br', 'nl', 'nld', 'dut', 'ru', 'rus',
  // Others common on subtitle sites
  'ar', 'ara', 'th', 'tha', 'vi', 'vie', 'id', 'ind', 'tr', 'tur', 'pl', 'pol', 'sv', 'swe', 'uk', 'ukr',
]);

/** The formats this module can read, for the viewer's file input. */
export const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'];
