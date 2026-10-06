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
 * @property {Set<string>} headwords  Every recognised SURFACE form, both scripts.
 * @property {Record<string, string>} variants  Traditional form -> the key in `words`.
 */

/** @type {Map<string, Dictionary>} */
const loaded = new Map();
/** @type {Map<string, Promise<Dictionary>>} */
const loading = new Map();

/**
 * Drop the cached dictionaries.
 *
 * The cache is per-worker-lifetime, which is right in production: a worker starts
 * on every wake and re-parsing 1.4MB each time would be felt. In a test harness
 * that evaluates the worker repeatedly in ONE process, the same cache silently
 * carries the first load into every later run — so a test that changes the served
 * word lists sees the previous ones and passes or fails for the wrong reason.
 *
 * Only the tests call this. Nothing in the extension does.
 */
export function resetDictionary() {
  // Wait for any in-flight loads before clearing, or a previous worker instance's
  // pending `loadDictionary()` resolves AFTER the reset and repopulates the cache
  // with the old data — which is how a later test saw a dictionary that did not
  // exist yet and reported an empty word list far from the cause.
  const pending = [...loading.values()];
  loaded.clear();
  loading.clear();
  return Promise.allSettled(pending);
}

/**
 * Build the lookup index from parsed data.
 *
 * Pure: takes the parsed JSON, returns a Dictionary. Nothing here knows where the
 * data came from, which is what lets it be called from a test with a literal, from
 * a browser with a fetched document, or from Node with a file — and is why this
 * module no longer reaches for `chrome`.
 *
 * The index built here is what makes TRADITIONAL text work. The data is keyed by
 * simplified form, so a traditional character is not a key, is not a headword, and
 * resolves to nothing — every traditional character rendered unmarked and
 * undefined. `variants` maps a traditional surface form back to the simplified key
 * it belongs to, and `headwords` includes both forms so the segmenter can find a
 * word in either script.
 *
 * @param {object} raw  The parsed data document.
 * @returns {Dictionary}
 */
export function indexDictionary(raw) {
  const simplified = new Set(Object.keys(raw.words));
  /** @type {Record<string, string>} */
  const variants = {};
  const headwords = new Set(simplified);

  // The longest headword bounds the segmentation window. Computed over BOTH
  // scripts, so a traditional form longer than any simplified one cannot fall
  // outside the window and go unmatched.
  let maxWordLength = 0;
  for (const key of simplified) {
    if (key.length > maxWordLength) maxWordLength = key.length;
  }

  for (const [key, entry] of Object.entries(raw.words)) {
    const traditional = entry.t;
    if (!traditional || traditional === key) continue;

    // A traditional form that is ITSELF a simplified headword is a genuine
    // ambiguity, and the simplified meaning wins: the text is being read as
    // simplified, so remapping it elsewhere would be wrong. None of the 6,675
    // variants in the current data collide, but this does not depend on that
    // staying true as the data changes.
    if (simplified.has(traditional) || traditional in variants) continue;

    variants[traditional] = key;
    headwords.add(traditional);
    if (traditional.length > maxWordLength) maxWordLength = traditional.length;
  }

  return {
    words: raw.words,
    levels: raw.levels,
    lists: raw.lists,
    maxWordLength,
    headwords,
    variants,
  };
}

/**
 * Load and index the bundled data.
 *
 * Fetched rather than imported so the JSON is not parsed at module load: the
 * service worker starts on every wake, and 1.4MB of JSON.parse on each one would
 * be felt. The result is cached for the worker's lifetime.
 *
 * The URL comes from the caller. Reading `chrome.runtime.getURL` here would make
 * this module unusable outside an extension — untestable in isolation, and unable
 * to be reused by anything that is not a Chrome extension. It is a data module;
 * where the data lives is not its business.
 *
 * @param {string} url
 * @returns {Promise<Dictionary>}
 */
export async function loadDictionary(url) {
  // Keyed by URL, not a single slot. The single slot was correct while there was
  // one dictionary and silently wrong the moment there were two: the second
  // request returned the first language's words, so every Japanese lookup missed
  // and every Japanese mark used Chinese headwords — with nothing throwing.
  const cached = loaded.get(url);
  if (cached) return cached;

  const inFlight = loading.get(url);
  if (inFlight) return inFlight;

  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load the word list (${response.status}).`);
    const dictionary = indexDictionary(await response.json());
    loaded.set(url, dictionary);
    return dictionary;
  })();

  loading.set(url, pending);
  try {
    return await pending;
  } finally {
    loading.delete(url);
  }
}

/**
 * Where the bundled list manifest lives, relative to the extension root.
 *
 * Kept here as a fact about the data rather than a call to `chrome` — the caller
 * resolves it, because only the caller knows whether it is a browser.
 */
export const INDEX_PATH = 'src/learn/data/index.json';

/**
 * Read the list manifest.
 *
 * Small on purpose (~1 KB): the worker loads it eagerly so the language and list
 * pickers can be filled without parsing any word data. With one language the
 * lists travelled inside the dictionary; with two, doing that would mean parsing
 * every language's words on every worker wake just to fill a dropdown.
 *
 * Pure with respect to the browser: the URL comes from the caller, exactly as
 * `loadDictionary` takes it, so this module still does not know whether it is
 * running in an extension.
 *
 * @param {string} url
 * @returns {Promise<{dictionaries: Record<string, string>, lists: object[]}>}
 */
export async function loadIndex(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the list index (${response.status}).`);
  const index = await response.json();

  // Fail loudly rather than returning something the caller will treat as "no
  // lists": an index that names a dictionary it does not describe, or the
  // reverse, is a build error and should not surface as an empty dropdown.
  const dictionaries = index.dictionaries ?? {};
  for (const list of index.lists ?? []) {
    if (!dictionaries[list.dictionary]) {
      throw new Error(`List "${list.id}" names dictionary "${list.dictionary}", which the index does not define.`);
    }
  }

  return { dictionaries, lists: index.lists ?? [] };
}

/**
 * The path of the dictionary holding a given list's words, or null.
 *
 * @param {{dictionaries: Record<string, string>, lists: object[]}} index
 * @param {string} listId
 * @returns {string|null}
 */
export function dictionaryPathFor(index, listId) {
  const list = index?.lists?.find((entry) => entry.id === listId);
  if (!list) return null;
  return index.dictionaries?.[list.dictionary] ?? null;
}

/**
 * The key a surface form is stored under.
 *
 * The data is keyed by simplified form, so a traditional word has to be mapped
 * back before it can be looked up. Everything that reads the dictionary goes
 * through here, which is what stops one caller remembering and another forgetting
 * — the failure mode being a word that is defined in one place and undefined in
 * the next.
 *
 * @param {Dictionary} dictionary
 * @param {string} word
 * @returns {string}
 */
export function canonical(dictionary, word) {
  return dictionary.variants?.[word] ?? word;
}

/**
 * The definition for a word, or null.
 *
 * @param {Dictionary} dictionary
 * @param {string} word
 * @returns {WordEntry|null}
 */
export function lookup(dictionary, word) {
  return dictionary.words[canonical(dictionary, word)] ?? null;
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
  return dictionary.levels[listId]?.[canonical(dictionary, word)] ?? null;
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
