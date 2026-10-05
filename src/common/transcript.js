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
    if (seconds >= segments[i].start) {
      // Past the last segment's end means playback is beyond the transcript.
      const end = segments[i].start + (segments[i].duration || 0);
      return seconds <= end || i === segments.length - 1 ? i : -1;
    }
  }
  return -1;
}
