/**
 * Every error the extension can report, as a single canonical list.
 *
 * An error code is how a report becomes specific. "Could not fetch captions" is
 * a dozen different faults wearing one sentence; `TRACK003` is one fault with one
 * cause, and it can be grepped in the source and in a log. When something goes
 * wrong in a real browser the learner can say the code and it resolves to one
 * place, instead of a paragraph that has to be re-diagnosed from scratch.
 *
 * CODES ARE STABLE. A code is never renumbered and never reused for a different
 * fault, a code that changes meaning is worse than no code, because it makes an
 * old report wrong rather than merely vague. Retiring a fault leaves its code
 * unused; adding one takes the next number in its category.
 *
 * FORMAT: `<CATEGORY><NNN>`, three letters and three digits. The category says
 * which layer failed, which is the first thing worth knowing:
 *
 *   CONN   reaching the page or its content script, the transport
 *   VIDEO  the page answered, but there is nothing to read
 *   TRACK  a caption track was found but could not be fetched or translated
 *   DICT   the bundled word list
 *   PAGE   the MAIN-world bridge
 *
 * The category is NOT `PROV`, deliberately: a caption fault is a caption fault
 * whichever site it came from, and encoding a provider in the code would mean a
 * new code for every site and no way to see a pattern across them.
 *
 * Every code carries a `message`, the sentence shown to the learner, and a
 * `detail` flag saying whether a `(…)` suffix belongs on it. A code whose message
 * already fully describes the fault takes no detail, so a caller cannot append a
 * raw exception and turn a stable code into an unstable string.
 *
 * The content script cannot `import` (classic scripts), so it carries its own
 * copy of the codes it raises. `test/errors.test.mjs` asserts the two stay in
 * step, the same arrangement `messages.js` uses for MSG and TARGET.
 *
 * ONE DELIBERATE EXCEPTION: `src/learn/wordlist.js` throws plain errors with no
 * code, because that module must import nothing (the layering guard in
 * `learn.test.mjs` enforces it, so it can be reused outside an extension). Its
 * throws are always caught by the worker, which applies DICT001/DICT002 at that
 * boundary. A code belongs to the layer that knows the context, and `learn/` is
 * the layer that knows only that a fetch returned 404.
 */

/** @typedef {{message: string, detail?: boolean}} ErrorDefinition */

/** @type {Record<string, ErrorDefinition>} */
export const ERRORS = Object.freeze({
  // --- CONN: reaching the page ------------------------------------------------
  CONN001: {
    message: 'No readable frame was found in this tab.',
    // No detail: there is no frame at all, so there is nothing more to say. The
    // commonest cause is a tab the extension is not allowed to script.
  },
  CONN002: {
    message: 'The page did not answer in time.',
    // The message type and the timeout go in the detail, because which request
    // stalled is the whole diagnosis and the timeout is the tuning knob.
    detail: true,
  },
  CONN003: {
    message: 'Could not reach the page.',
    detail: true,
  },
  CONN004: {
    message: 'Could not read this video.',
    detail: true,
  },
  CONN005: {
    message: 'No supported video is open in the active tab.',
    // Naming the site is worth the detail: a learner sitting on a video site the
    // extension does not support otherwise reads this as "the extension is
    // broken", when it means "this particular site is not one I read".
    detail: true,
  },

  // --- VIDEO: the page answered, nothing to read ------------------------------
  VIDEO001: {
    message: 'This video has no captions.',
  },
  VIDEO002: {
    message: 'This page has no video player.',
  },
  VIDEO003: {
    message: 'Could not read this video’s captions.',
    detail: true,
  },
  VIDEO004: {
    message: 'Could not reach the player API.',
    detail: true,
  },

  // --- TRACK: a track was found, fetching it failed ---------------------------
  TRACK001: {
    message: 'This caption track cannot be auto-translated.',
  },
  TRACK002: {
    message: 'The caption track came back empty.',
  },
  TRACK003: {
    message: 'Could not load captions.',
    detail: true,
  },
  TRACK004: {
    message: 'Could not load the selected track.',
    detail: true,
  },
  TRACK005: {
    // Added because TRACK002 is reported when a response arrives with no
    // parseable cues, which is also what a REFUSAL looks like. A block page is
    // HTTP 200 with an HTML body: no `<text>` elements, so it parses to zero cues
    // and was reported as "the caption track came back empty". That told the
    // viewer the video had no captions when the truth was that the server stopped
    // answering, and it sent a whole debugging session the wrong way.
    //
    // A refusal is temporary and the fix for it is to wait; an empty track is a
    // fact about the video. Conflating them makes the wrong one look like the
    // right one, which is the most expensive kind of error message.
    message: 'The caption request was refused, likely too many requests.',
  },

  // --- DICT: the bundled word list --------------------------------------------
  DICT001: {
    message: 'The word list could not be loaded.',
    detail: true,
  },
  DICT002: {
    message: 'Could not read the word list.',
    detail: true,
  },

  // --- PAGE: the MAIN-world bridge --------------------------------------------
  PAGE001: {
    message: 'The page bridge did not understand a request.',
    detail: true,
  },

  // --- VIEWER: the local video page, which is a source we host ---------------
  //
  // This is our own page rather than a site, so its failures are about the
  // USER'S files. That changes what a useful message is: a website can be
  // retried, but a Blu-ray rip will never have text subtitles no matter how many
  // times it is offered, and the honest answer names the file type.
  VIEWER001: {
    message: 'Could not open the video viewer.',
    detail: true,
  },
  VIEWER002: {
    // The detail is the reason: which decoder was tried, or that zero cues came
    // out. A subtitle file that parses to nothing is the case worth naming.
    message: 'Could not read that subtitle file.',
    detail: true,
  },
  VIEWER003: {
    // Deliberately not "unsupported format". Chrome refuses a file for reasons
    // it does not tell us, a codec it has no decoder for, or a container it
    // cannot demux, and guessing which would be a worse message than this.
    message: 'This browser cannot play that video file.',
    detail: true,
  },
  VIEWER004: {
    // Image subtitles. A fact about the file, not a fault: PGS and VobSub are
    // pictures of text and there is no string in them to mark.
    message: 'These subtitles are images (Blu-ray PGS or DVD VobSub) and cannot be read. Use a text subtitle file.',
    detail: false,
  },
  VIEWER005: {
    message: 'This video has no subtitles, embedded or otherwise. Choose a .srt, .vtt or .ass file.',
    detail: false,
  },
});

/**
 * A code: two to six uppercase letters, then exactly three digits. `CONN002`.
 *
 * The width is a range rather than a fixed 3 because the category is a SLUG, not
 * an abbreviation, `CONN` and `VIDEO` are both natural, and forcing either to
 * three letters would produce `VID`, which reads as a truncation. It was 3 here
 * at first and every check silently failed to match, which is the failure mode
 * of a pattern that is too strict: nothing looks wrong, it just never matches.
 */
export const CODE_PATTERN = /^[A-Z]{2,6}\d{3}$/;

/**
 * The full text for an error: the code, then the sentence, then any detail.
 *
 * The code comes FIRST so it survives truncation. The panel shows a single
 * clipped status line, and a code at the end of a long sentence is the part that
 * gets cut, which is exactly the part worth keeping.
 *
 * @param {string} code
 * @param {string} [detail] Extra context from the underlying failure.
 * @returns {string}
 */
export function errorText(code, detail) {
  const definition = ERRORS[code];
  // An unknown code is a bug, and it must not be silent: it prints as itself so
  // a report says `CONN999` rather than looking like a plain unexplained fault.
  if (!definition) return detail ? `${code} Unknown error (${detail})` : `${code} Unknown error.`;

  const detailAllowed = definition.detail && detail !== undefined && detail !== null && detail !== '';
  return detailAllowed ? `${code} ${definition.message} (${detail})` : `${code} ${definition.message}`;
}

/**
 * Wrap a caught error, unless it is already coded.
 *
 * Codes propagate outward: the layer closest to the failure knows best what
 * failed. `sendToContent` raises a `CONN002` timeout, and the refresh path that
 * calls it must NOT wrap that in its own `CONN003`, a report reading
 * `CONN003 … (CONN002 …)` has two codes for one fault and the outer one is
 * noise. So an already-coded message is passed through untouched and the
 * fallback code applies only to something uncoded.
 *
 * @param {string} code Fallback code for an uncoded failure.
 * @param {any} error
 * @returns {string}
 */
export function codeError(code, error) {
  const message = String(error?.message ?? error ?? '');
  if (CODE_PREFIX.test(message)) return message;
  return errorText(code, message);
}

/** Matches a message that already begins with a code, e.g. `CONN002 …`. */
const CODE_PREFIX = /^[A-Z]{2,6}\d{3}(?:\s|$)/;

/**
 * Every code in the registry, for tests and for tooling.
 *
 * @returns {string[]}
 */
export function errorCodes() {
  return Object.keys(ERRORS);
}
