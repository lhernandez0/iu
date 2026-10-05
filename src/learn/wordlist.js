/**
 * The dictionary and the word lists it carries.
 *
 * Two things live here, deliberately separate:
 *
 *   - **Definitions**, which we have for every word in the data.
 *   - **Levels**, which we have for most but not all, per word list.
 *
 * Keeping them apart is what makes an unlevelled word behave correctly: it gets
 * a definition and no colour, rather than being forced into a level it does not
 * have. The word list is a property of a word, not a property of knowing it.
 *
 * Nothing here knows what HSK is. A list has an id, a label, a language and a
 * level count; that is the entire contract, so JLPT or any other graded list
 * slots in without touching this file.
 */

/** @typedef {{p: string, m: string, t: string, pos: string}} WordEntry */

/**
 * @typedef {Object} WordList
 * @property {string} id
 * @property {string} label
 * @property {string} language
 * @property {number} levelCount
 * @property {number} levelled   How many words carry a level in this list.
 */

/**
 * @typedef {Object} Dictionary
 * @property {Record<string, WordEntry>} words
 * @property {Record<string, Record<string, number>>} levels  list id -> word -> level
 * @property {WordList[]} lists
 * @property {number} maxWordLength  Longest headword, which bounds the search.
 */

/** @type {Dictionary|null} */
let loaded = null;
/** @type {Promise<Dictionary>|null} */
let loading = null;

/**
 * Load and index the bundled data.
 *
 * Fetched rather than imported so the JSON is not parsed at module load: the
 * service worker starts on every wake, and 1.4MB of JSON.parse on each one would
 * be felt. The result is cached for the worker's lifetime.
 *
 * @returns {Promise<Dictionary>}
 */
export async function loadDictionary() {
  if (loaded) return loaded;
  if (loading) return loading;

  loading = (async () => {
    const url = chrome.runtime.getURL(DATA_PATH);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load the word list (${response.status}).`);

    const raw = await response.json();

    // The longest headword bounds the segmentation window. Computing it here
    // means the segmenter never has to assume a length — a language with longer
    // words would simply raise it.
    let maxWordLength = 0;
    for (const word of Object.keys(raw.words)) {
      if (word.length > maxWordLength) maxWordLength = word.length;
    }

    loaded = {
      words: raw.words,
      levels: raw.levels,
      lists: raw.lists,
      maxWordLength,
    };
    return loaded;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

export const DATA_PATH = 'src/learn/data/chinese.json';

/**
 * The definition for a word, or null.
 *
 * @param {Dictionary} dictionary
 * @param {string} word
 * @returns {WordEntry|null}
 */
export function lookup(dictionary, word) {
  return dictionary.words[word] ?? null;
}

/**
 * The level a word sits at in a given list, or null when it has none.
 *
 * Null is a real answer, not a failure: a word can be perfectly ordinary and
 * simply sit outside every graded list. Callers must treat it as "no colour"
 * rather than "easy".
 *
 * @param {Dictionary} dictionary
 * @param {string} listId
 * @param {string} word
 * @returns {number|null}
 */
export function levelOf(dictionary, listId, word) {
  return dictionary.levels[listId]?.[word] ?? null;
}

// --- Colour ------------------------------------------------------------------

/**
 * The default ramp: easy to hard.
 *
 * A fixed perceptual gradient rather than a hue rotation. Rotating the hue
 * looks fine at six levels and breaks by twelve — the wheel wraps, so level 1
 * and level 13 become the same colour. Interpolating between fixed stops
 * cannot do that, and stays readable whether a list has 6 levels or 40.
 *
 * Low saturation on purpose: these sit under body text and must not fight it.
 */
export const DEFAULT_PALETTE = ['#4f9d69', '#8fbf4f', '#e0b33c', '#e07f3c', '#c94f4f'];

/**
 * Place a level on the ramp and return a colour.
 *
 * `t` is the level's position across the whole range, so the first level is
 * always the coolest stop and the last always the warmest, whatever the list's
 * size. That is what makes this work for a 6-level and a 40-level list alike.
 *
 * @param {number} level       1-based.
 * @param {number} levelCount  Total levels in the list.
 * @param {string[]} [palette]
 * @returns {string} A CSS colour.
 */
export function levelColour(level, levelCount, palette = DEFAULT_PALETTE) {
  if (!Number.isFinite(level) || levelCount <= 1) return palette[0];

  // Clamp: a level outside the declared range should still render something
  // sensible rather than extrapolating to a colour that is not in the palette.
  const t = Math.min(1, Math.max(0, (level - 1) / (levelCount - 1)));
  return interpolate(palette, t);
}

/**
 * @param {string[]} stops
 * @param {number} t 0..1
 * @returns {string}
 */
function interpolate(stops, t) {
  if (stops.length === 1) return stops[0];

  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const local = scaled - index;

  const from = parseHex(stops[index]);
  const to = parseHex(stops[index + 1]);
  if (!from || !to) return stops[index];

  const mix = (a, b) => Math.round(a + (b - a) * local);
  return `rgb(${mix(from[0], to[0])}, ${mix(from[1], to[1])}, ${mix(from[2], to[2])})`;
}

/**
 * @param {string} hex
 * @returns {[number, number, number]|null}
 */
function parseHex(hex) {
  const match = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
