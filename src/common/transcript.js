/**
 * Transcript helpers shared by extension pages (ES modules).
 *
 * Content scripts are classic scripts and cannot import this file; they return
 * raw `{ start, duration, text }` segments and leave formatting to the pages.
 *
 * @typedef {Object} Segment
 * @property {number} start    Seconds from the beginning of the video.
 * @property {number} duration Seconds. May be 0 when the source omitted it.
 * @property {string} text
 */

/**
 * `m:ss` under an hour, `h:mm:ss` over it. Matches what YouTube's own
 * transcript panel shows.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * SubRip timestamp: `HH:MM:SS,mmm`.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatSrtTime(seconds) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(Math.floor(ms / 3600000))}:` +
    `${pad(Math.floor(ms / 60000) % 60)}:` +
    `${pad(Math.floor(ms / 1000) % 60)},` +
    `${pad(ms % 1000, 3)}`
  );
}

/**
 * Plain text, one segment per line.
 *
 * @param {Segment[]} segments
 * @returns {string}
 */
export function toPlainText(segments) {
  return segments.map((segment) => segment.text).join('\n');
}

/**
 * SubRip. A segment with no duration gets one second so the cue is not
 * zero-length (players vary in how they handle those).
 *
 * @param {Segment[]} segments
 * @returns {string}
 */
export function toSrt(segments) {
  return segments
    .map((segment, index) => {
      const start = formatSrtTime(segment.start);
      const end = formatSrtTime(segment.start + (segment.duration || 1));
      return `${index + 1}\n${start} --> ${end}\n${segment.text}\n`;
    })
    .join('\n');
}

/**
 * Index of the segment covering `seconds`, or -1.
 *
 * @param {Segment[]} segments
 * @param {number} seconds
 * @returns {number}
 */
export function findActiveIndex(segments, seconds) {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (seconds >= segments[i].start) return i;
  }
  return -1;
}

/** @typedef {{start: number, duration: number, text: string}} Segment */

/**
 * Line up a second track against the first, so both can be drawn together.
 *
 * Two caption tracks for the same video are separate downloads with
 * independent cue boundaries: a cue in one language usually starts within a
 * fraction of a second of its counterpart, but never at exactly the same
 * millisecond, and the counts differ because one language needs more cues.
 * There is no id linking them.
 *
 * So both lists are walked once with a cursor, matching each primary cue to the
 * nearest secondary cue by start time. Two properties matter, and both are load
 * bearing:
 *
 *   - **A cue is used at most once.** Without this, a sparse second track would
 *     repeat one cue across several primary lines, the same translation of one
 *     sentence shown against two different sentences.
 *   - **A pair further apart than `maxDriftMs` is unmatched** and left blank.
 *     Without this, a track offset by a few seconds would put a
 *     plausible-looking but wrongly-timed translation on every line, which is
 *     worse than showing nothing.
 *
 * @param {Segment[]} primary
 * @param {Segment[]} secondary
 * @param {number} [maxDriftMs] Maximum start-time difference to accept.
 * @returns {string[]} One entry per primary segment; '' where unmatched.
 */
export function alignSecondary(primary, secondary, maxDriftMs = 1500) {
  const aligned = new Array(primary.length).fill('');
  if (!secondary.length || !primary.length) return aligned;

  const tolerance = maxDriftMs / 1000;
  let cursor = 0;

  for (let i = 0; i < primary.length; i++) {
    const target = primary[i].start;

    // Drop secondary cues that sit too far behind this cue to ever be its
    // translation. A later primary cue starts even later, so they cannot match
    // it either, they are spent.
    while (cursor < secondary.length && secondary[cursor].start < target - tolerance) cursor++;
    if (cursor >= secondary.length) break; // nothing left to match; the rest stay blank

    // If the cue after the cursor is a closer match, step to it and reconsider
    // this same primary cue. The cursor only moves forward, so this terminates.
    if (
      cursor + 1 < secondary.length &&
      Math.abs(secondary[cursor + 1].start - target) < Math.abs(secondary[cursor].start - target)
    ) {
      cursor++;
      i--;
      continue;
    }

    if (Math.abs(secondary[cursor].start - target) <= tolerance) {
      aligned[i] = secondary[cursor].text;
      cursor++; // spoken for: this cue cannot translate a second line
    }
  }

  return aligned;
}

