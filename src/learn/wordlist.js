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

/**
 * How a word is read — 拼音 for Chinese, kana for Japanese — or null.
 *
 * Both languages store this in the SAME field, `p`, because the data was built
 * from sources with the same shape: CC-CEDICT carries pinyin, JMdict carries the
 * kana reading. So this is one function and not two, which is worth stating
 * because "pinyin" and "the reading" are the same field and it would be easy to
 * assume otherwise from the name.
 *
 * `canonical` is applied first, and that is the part worth remembering: the data
 * is keyed by simplified form, so looking up a traditional surface form directly
 * finds nothing. Resolving through `canonical` gives a traditional word its own
 * reading instead of silently none — a failure that would look like missing data
 * rather than a missing lookup.
 *
 * @param {Dictionary} dictionary
 * @param {string} word
 * @returns {string|null}
 */
export function readingOf(dictionary, word) {
  const entry = lookup(dictionary, word);
  // An empty string is present-but-empty in the data (JMdict has these for
  // symbols and loanwords with no kana), treated the same as absent — a blank
  // reading is not something to draw.
  return entry?.p || null;
}

/**
 * The other script's form of a Chinese word, or null.
 *
 * `t` is the traditional form, carried by every one of the 11,470 entries. There
 * is no simplified field because the data is KEYED by simplified: the key already
 * is that form.
 *
 * @param {Dictionary} dictionary
 * @param {string} word
 * @returns {string|null}
 */
export function traditionalOf(dictionary, word) {
  return lookup(dictionary, word)?.t || null;
}

/**
 * The tone-marked pinyin form a reading is written in, turned into numbered.
 *
 * `māma` becomes `ma1ma`, and `le` stays `le` — a syllable with no mark is the
 * neutral tone and carries no number, which is the part a version built from the
 * Latin letters alone gets wrong by appending `0` or nothing at the end of the
 * whole string rather than per syllable.
 *
 * `ü` is handled because the data uses it (`lǜ` for 绿) and a table of the five
 * vowels would silently leave it alone.
 *
 * @param {string} reading
 * @returns {string}
 */
/**
 * A tone-marked reading as numbered pinyin: `zhōngyú` becomes `zhong1yu2`.
 *
 * **The numbering is per SYLLABLE, and syllable boundaries cannot be found from
 * the letters.** `zhongyu` could split as `zhong-yu` or `zho-ng-yu`, and nothing
 * in the string says which — so two simpler implementations both produce
 * something wrong:
 *
 *   - write the digit where the vowel was: `zho1ngyu2`, a number inside a syllable
 *   - flush it at spaces: `zhongyu2`, because a Chinese word is written with no
 *     spaces between its syllables at all
 *
 * So the string is segmented against the real inventory of Mandarin syllables
 * first, then each syllable gets its digit at the end. That also makes the
 * conversion reversible, which is the point of numbered pinyin — it exists so a
 * reading can be typed and searched.
 *
 * @param {string} reading
 * @returns {string}
 */
export function pinyinToNumbers(reading) {
  if (!reading) return '';

  // Tone marks become plain letters plus a digit per POSITION, so the two strings
  // stay index-aligned and a syllable's digit can be found from its range.
  let plain = '';
  /** @type {string[]} */
  const tones = [];
  for (const char of reading) {
    const mapped = TONE_NUMBERS[char];
    if (mapped === undefined) {
      plain += char;
      tones.push('');
    } else {
      plain += mapped[0];
      // A missing digit is the neutral tone, not an unknown one.
      tones.push(mapped.length > 1 ? mapped[1] : '');
    }
  }

  // Runs of letters are split as a whole, because the boundaries between them are
  // not visible in the string — see `splitSyllables`.
  return numberRuns(plain, tones);
}

/**
 * Segment a pinyin string and put each syllable's tone after it.
 *
 * A run of letters is split by `splitSyllables`; anything between runs (spaces,
 * apostrophes, hyphens) is passed through as the author wrote it, because it is
 * their punctuation rather than ours.
 *
 * @param {string} plain  Tone marks already replaced with plain letters.
 * @param {string[]} tones  One entry per character, `''` for the neutral tone.
 * @returns {string}
 */
function numberRuns(plain, tones) {
  let out = '';
  let i = 0;

  while (i < plain.length) {
    if (!SYLLABLE_LETTER.test(plain[i])) {
      out += plain[i];
      i++;
      continue;
    }

    // The end of this run of letters.
    let end = i;
    while (end < plain.length && SYLLABLE_LETTER.test(plain[end])) end++;
    const run = plain.slice(i, end);

    const split = splitSyllables(run);
    if (!split) {
      // No complete split exists — a shape the table does not know. Emitted whole
      // with its last tone, so an unexpected string degrades to one wrong digit
      // rather than to lost text.
      const digit = tones.slice(i, end).filter(Boolean).pop();
      out += digit ? `${run}${digit}` : run;
      i = end;
      continue;
    }

    let at = i;
    for (const length of split) {
      const syllable = plain.slice(at, at + length);
      // The LAST tone in the syllable. A well-formed one carries exactly one, so
      // this is that one; a malformed one is resolved deterministically rather
      // than by whichever digit happened to come first.
      const digit = tones.slice(at, at + length).filter(Boolean).pop();
      out += digit ? `${syllable}${digit}` : syllable;
      at += length;
    }
    i = end;
  }

  return out;
}

/**
 * Split a run of toneless pinyin into syllables, or null if it cannot be done.
 *
 * **Backtracking, not greedy, and the difference is the whole function.** Written
 * pinyin has no separator between syllables, so `fanu` is ambiguous: it could be
 * `fan` + `u` or `fa` + `nu`. Longest-match takes `fan` — the longer reading — and
 * then has an impossible `u` left over. The correct split is the shorter first
 * syllable, which greedy never tries, and which only a search finds.
 *
 * That case is real data, not a contrived one: `fānù` (发怒) is `fa` + `nu`, and it
 * is one of the entries that failed the exhaustive check.
 *
 * Result: the longest split that consumes the WHOLE run. Ambiguity with more than
 * one valid split resolves to the longest first syllable, which is the convention
 * dictionaries use.
 *
 * @param {string} run
 * @returns {number[]|null} Syllable lengths in order, or null.
 */
function splitSyllables(run) {
  const lower = run.toLowerCase();
  /** @type {Map<number, number[]|null>} */
  const memo = new Map();

  /** @param {number} at */
  function walk(at) {
    if (at === lower.length) return [];
    if (memo.has(at)) return memo.get(at);

    // Longest first, so of two valid splits the longer opening syllable wins.
    for (let length = Math.min(MAX_SYLLABLE, lower.length - at); length >= 1; length--) {
      if (!PINYIN_SYLLABLES.has(lower.slice(at, at + length))) continue;
      const rest = walk(at + length);
      if (rest) {
        const out = [length, ...rest];
        memo.set(at, out);
        return out;
      }
    }

    memo.set(at, null);
    return null;
  }

  return walk(0);
}

/** The longest syllable in the inventory (`zhuang`, `chuang`). */
const MAX_SYLLABLE = 6;

/** What counts as inside a syllable, so a tone is not flushed mid-word. */
const SYLLABLE_LETTER = /[a-zü]/i;

/**
 * Every Mandarin syllable, toneless.
 *
 * The inventory is closed — about 410 forms — which is what makes longest-match
 * segmentation exact rather than heuristic. Derived from the standard pinyin
 * table; `v` stands in for `ü`, as it does everywhere numbered pinyin is typed.
 */
export const PINYIN_SYLLABLES = new Set(
  (
    'a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ' +
    'ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo ' +
    'da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo ' +
    'e ei en eng er fa fan fang fei fen feng fo fou fu ' +
    'ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ' +
    'ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ' +
    'ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ' +
    'ka kai kan kang kao ke ken keng kong kou ku kua kuai kuan kuang kui kun kuo ' +
    'la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lv lve ' +
    'ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu ' +
    'na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nun nuo nv nve ' +
    // `nu`/`nv` were missing from the n row, so `nù` split as `n`+`u` — a         // one-letter fallback that still produced a digit, which is why only the
    // exhaustive decomposition check could see it.
    'n ng hm hng m ' +
    'o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu ' +
    'qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ' +
    'ran rang rao re ren reng ri rong rou ru ruan rui run ruo ' +
    'sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ' +
    'ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo ' +
    'wa wai wan wang wei wen weng wo wu ' +
    'xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ' +
    'ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun ' +
    'za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo ' +
    // FINALS, which are not standalone syllables but must be matchable, because
    // written pinyin has no separator between syllables: `bàngōng` is `bang` +
    // `ong`, and a table of standalone syllables alone splits it into `bang` +
    // `o` + `ng` — digits in the wrong places, which is what the exhaustive
    // check caught. Longest-match still prefers `bang` over `ba`+`ng`, so adding
    // these cannot steal a syllable that already matched whole.
    'ong uan iang uang iong uo ua ia iao ian ie iu in ing ui un ue uai ve er r ' +
    'ang eng ong ao an ai ou ei en ia ua uo uai uan uang ue ui un v'
  ).split(' '),
);

/**
 * Tone-marked vowel to the plain letter and its tone number.
 *
 * The neutral tone maps to no digit, which is why a value can be one character
 * long. `ü` is here because it appears with a tone in the data and without one in
 * the plain form.
 */
const TONE_NUMBERS = {
  ā: 'a1', á: 'a2', ǎ: 'a3', à: 'a4',
  ē: 'e1', é: 'e2', ě: 'e3', è: 'e4',
  ī: 'i1', í: 'i2', ǐ: 'i3', ì: 'i4',
  ō: 'o1', ó: 'o2', ǒ: 'o3', ò: 'o4',
  ū: 'u1', ú: 'u2', ǔ: 'u3', ù: 'u4',
  ǖ: 'v1', ǘ: 'v2', ǚ: 'v3', ǜ: 'v4',
  ü: 'v',
};

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
