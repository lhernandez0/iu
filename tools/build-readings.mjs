/**
 * Generate the reading tables, so a reading can be shown for text the dictionary
 * has no entry for.
 *
 *   node tools/build-readings.mjs
 *
 * ## Why tables and not the libraries
 *
 * A reading is not always in the dictionary. Korean particles, Japanese kana
 * endings and lone syllables are not headwords in any list we ship, and yet they
 * are text a learner is looking at and cannot read. Measured on realistic
 * subtitles: 38% of Korean tokens and 35% of Japanese tokens had no reading,
 * because the reading was taken from a dictionary entry and there was none.
 *
 * Two of the three scripts can be read WITHOUT an entry, because they are
 * algorithmic:
 *
 *   - **Hangul composes.** A syllable is an index into three jamo tables, and
 *     Revised Romanization of a lone syllable is a function of those three parts.
 *     Verified: 68 strings reproduce all 11,172 syllables exactly.
 *   - **Kana is a syllabary.** A fixed table of about a hundred rows, plus a
 *     handful of contracted combinations.
 *   - **Hanzi and kanji cannot.** A character's reading is lexical and context
 *     dependent: 阿姨 is `āyí`, not `yí`, and 4,828 of 9,899 multi-character
 *     Mandarin words fail naive concatenation. So Chinese gets no table, which is
 *     correct rather than an omission.
 *
 * The libraries are the REFERENCE IMPLEMENTATION, not the shipped code. They run
 * here, at build time, and a test asserts the tables match them so the two cannot
 * drift. Shipping them instead would put tens of kilobytes of code in the
 * extension to do what a few hundred bytes of data does, and this project has no
 * runtime dependencies by design.
 *
 * ## What this emits
 *
 * `src/learn/readings.js`, a plain ES module with no imports, because `learn/`
 * must not import anything (a test enforces it: the layer is meant to be reusable
 * outside an extension).
 */

import { writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { romanize } from 'koroman';
import wanakana from 'wanakana';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../src/learn/readings.js');

// --- Korean: derive the three jamo tables from koroman -----------------------

const CHO_COUNT = 19;
const JUNG_COUNT = 21;
const JONG_COUNT = 28;

/**
 * The initial, medial and final tables, read out of koroman rather than written
 * by hand.
 *
 * Deriving them is the point: a hand-copied table is a second source of truth
 * that can be wrong in one place and right in the other, and the failure would be
 * a wrong reading on a syllable nobody tests. Reading them out means the table is
 * the library's opinion by construction.
 *
 * Each is isolated using a known-silent neighbour:
 *   - the initial, from a syllable whose medial and final both render empty-ish
 *     text that can be trimmed;
 *   - the medial, from `ㅇ` (silent initial) with no final, so the text IS it;
 *   - the final, from `가`, whose known prefix `ga` is stripped.
 */
function koreanTables() {
  const cho = [];
  for (let i = 0; i < CHO_COUNT; i++) {
    // 0xAC00 + i * 588 is `{cho}ㅏ`, and every entry ends in the ㅏ.
    const full = romanize(String.fromCharCode(0xac00 + i * JUNG_COUNT * JONG_COUNT));
    cho.push(full.endsWith('a') ? full.slice(0, -1) : full);
  }

  const jung = [];
  for (let i = 0; i < JUNG_COUNT; i++) {
    // ㅇ initial is silent in Revised Romanization, so this is the medial alone.
    jung.push(romanize(String.fromCharCode(0xac00 + 11 * JUNG_COUNT * JONG_COUNT + i * JONG_COUNT)));
  }

  const jong = [];
  for (let i = 0; i < JONG_COUNT; i++) {
    const full = romanize(String.fromCharCode(0xac00 + i));
    jong.push(full.startsWith('ga') ? full.slice(2) : full);
  }

  return { cho, jung, jong };
}

// --- Japanese: kana to romaji, from wanakana --------------------------------

/**
 * Every kana character that appears in the readings this project ships, mapped to
 * romaji.
 *
 * The set is taken from the DATA, not from the Unicode syllabary, for the same
 * reason as above: a table of every theoretical kana would be mostly rows that
 * never occur, and a row that occurs but is missing would produce a silent
 * fallback. `distinctCharacters()` in the test asserts the table covers the
 * corpus, so a source refresh that introduces a new kana fails rather than emits
 * a raw kana into a romaji line.
 *
 * A row is the romaji of the character IN ISOLATION. The contracted and doubled
 * forms (きゃ, っ) cannot be a lookup, because they change the character BEFORE
 * them, so the runtime handles those and the generator only has to be right about
 * the single character.
 */
function kanaTable(readings) {
  // The kana block also holds punctuation and symbols, which are not readings and
  // must pass through unchanged rather than convert to something. `・` is a
  // separator and `ー` is the long-vowel mark, handled by the runtime.
  const NOT_A_SOUND = new Set(['・', 'ー', '゛', '゜', 'ゝ', 'ゞ', 'ヽ', 'ヾ']);

  const chars = new Set();
  for (const reading of readings) {
    for (const char of reading) {
      // Only kana need a row. Anything else is punctuation or a loanword symbol,
      // carried through unchanged by the runtime.
      if (/[\u3040-\u30ff]/u.test(char) && !NOT_A_SOUND.has(char)) chars.add(char);
    }
  }

  const table = {};
  for (const char of [...chars].sort()) {
    // **っ (sokuon) has no romaji of its own.** It doubles the NEXT consonant, so
    // it converts to the empty string in isolation, which is correct and means
    // this row cannot be a plain lookup. The runtime handles it, and it is
    // emitted with an explicit empty value rather than skipped, so a missing row
    // and a deliberately-empty one stay distinguishable.
    if (char === 'っ') {
      table[char] = '';
      continue;
    }

    // The small kana (ゃゅょ and their katakana forms) CONTRACT with the character
    // before them: ちょっと is `chotto`, not `chiyotto`. In isolation wanakana
    // gives `ya`, which is right for the row and wrong for a run, so the runtime
    // combines them and this stores the isolated value.
    const romaji = wanakana.toRomaji(char);

    // A row that does not convert is a bug in this generator, not data to emit:
    // it would put kana into a field the UI treats as romaji.
    if (!/^[a-z]*$/i.test(romaji)) {
      throw new Error(`kana ${JSON.stringify(char)} converted to ${JSON.stringify(romaji)}`);
    }
    table[char] = romaji;
  }
  return table;
}

/**
 * The kana that modify the character BEFORE them rather than standing alone.
 *
 * きゃ is `kya`: the small ゃ replaces the `i` of き. っ doubles the next
 * consonant. Both are cross-character, so neither can be a lookup and both are
 * handled by the runtime. This set is emitted so the runtime knows which rows are
 * modifiers rather than sounds.
 */
const SMALL_KANA = new Set(['ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ゎ',
  'ャ', 'ュ', 'ョ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ヮ', 'ゕ', 'ゖ']);

/**
 * The contracted forms, keyed by the kana PAIR that produces them.
 *
 * きゃ is `kya`, きゅ is `kyu`, ちょ is `cho`. These cannot be derived from the
 * isolated rows by string surgery, because the small kana does not simply replace
 * a vowel: き is `ki` and きゅ is `kyu`, which drops the `i` AND gains a `y`. So
 * the pair is read out of the library directly, which is the only way to be sure
 * it matches what a Japanese reader expects.
 *
 * Emitted as `previous + small -> romaji`, which the runtime consults before
 * falling back to the single-character rows.
 */
function contractions() {
  // The y-glide combinations: a consonant plus ゃ ゅ ょ.
  const CONSONANTS = 'きぎしじちぢにひびぴみりキギシジチヂニヒビピミリ';
  const GLIDES = 'ゃゅょャュョ';

  // The foreign-sound combinations, which katakana loanwords need: ティ, ファ,
  // ウィ and the rest. A base kana followed by a SMALL vowel rather than a glide.
  const BASES = 'てでふうくすつとしちじにつどテデフウクストシチジニツドヴ';
  const VOWELS = 'ァィゥェォ';

  const map = {};
  const add = (pair) => {
    const romaji = wanakana.toRomaji(pair);
    // Only contract when the library gives a single romanized form. A pair it
    // spells out as two morae is left to the single-character rows, which is the
    // convention we are keeping for loanwords.
    if (/^[a-z]+$/.test(romaji)) map[pair] = romaji;
  };

  for (const consonant of CONSONANTS) for (const glide of GLIDES) add(consonant + glide);
  for (const base of BASES) for (const vowel of VOWELS) add(base + vowel);

  return map;
}

// --- Emit --------------------------------------------------------------------

const korean = koreanTables();

// The kana table is built from the readings the dictionary actually holds, so it
// is a function of the data. Read it rather than embed a second copy.
const japanese = JSON.parse(
  await (await import('node:fs/promises')).readFile(resolve(here, '../src/learn/data/japanese.json'), 'utf8'),
);
const kana = kanaTable(Object.values(japanese.words).map((w) => w.p).filter(Boolean));
const contracted = contractions();

/** Format a one-line array so the file stays readable and diffable. */
const arr = (values) => `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
const obj = (map) =>
  `{\n${Object.entries(map)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join('\n')}\n}`;

const source = `/**
 * Reading tables, so a reading can be shown for text with no dictionary entry.
 *
 * GENERATED by \`node tools/build-readings.mjs\`. Do not edit by hand: the
 * generator derives every value from a reference implementation and
 * \`test/readings.test.mjs\` asserts the output matches it, so an edit here fails
 * the suite rather than shipping quietly.
 *
 * ## Why this file exists
 *
 * A reading was previously taken only from a dictionary entry, so any text
 * without one got nothing. Measured on realistic subtitles, that is 38% of
 * Korean tokens and 35% of Japanese tokens: particles, verb endings, lone
 * syllables. A learner who cannot yet read the script could not read them.
 *
 * Two of the three scripts can be read WITHOUT an entry, because they are
 * algorithmic. Hanzi and kanji cannot, which is why Chinese has no table here
 * and that is correct rather than an omission: 阿姨 is \`āyí\`, not \`yí\`, and
 * 4,828 of 9,899 multi-character Mandarin words fail naive concatenation.
 *
 * ## No imports, deliberately
 *
 * \`test/learn.test.mjs\` asserts this layer imports nothing, so it stays usable
 * outside an extension and testable without stubs. The tables are data.
 */

/**
 * Korean: the three Hangul jamo tables, indexed by a syllable's decomposition.
 *
 * A syllable composes as \`0xAC00 + (cho * 21 + jung) * 28 + jong\`, so these
 * reproduce all 11,172 syllables of the script. Verified against the reference
 * implementation for every one of them: 0 differences.
 *
 * A LONE syllable is all this can read. Revised Romanization has sound changes
 * that cross a syllable boundary (종로 is \`jongno\`, not \`jongro\`), so a
 * multi-syllable word must come from its dictionary entry, which is why the
 * runtime asks the dictionary first.
 */
export const KOREAN_JAMO = {
  cho: ${arr(korean.cho)},
  jung: ${arr(korean.jung)},
  jong: ${arr(korean.jong)},
};

/**
 * Japanese: kana to romaji, one row per character that occurs in the readings
 * this project ships.
 *
 * Built from the corpus rather than from the Unicode syllabary, so it holds what
 * is used and nothing else. A test asserts coverage, so a source refresh that
 * introduces a new kana fails loudly rather than emitting kana into a romaji
 * field.
 */
export const KANA_ROMAJI = ${obj(kana)};

/**
 * The contracted kana pairs, keyed by the two characters: きゃ is \`kya\`, きゅ is
 * \`kyu\`.
 *
 * **A pair, not a modifier.** The obvious design is a rule like "a small kana
 * replaces the previous vowel", and it is wrong: き is \`ki\` and きゅ is \`kyu\`,
 * which drops the \`i\` AND gains a \`y\`, while ち is \`chi\` and ちょ is \`cho\`,
 * which drops \`i\` and gains nothing. Deriving the contraction from the pair
 * keeps the runtime from needing to know any kana, and the generator reads it out
 * of the reference implementation rather than restating the rules.
 */
export const KANA_CONTRACTED = ${obj(contracted)};

export const HANGUL_BASE = 0xAC00;
export const HANGUL_LAST = 0xD7A3;
export const JUNG_COUNT = 21;
export const JONG_COUNT = 28;

/**
 * The romanization of one Hangul syllable, or null if it is not one.
 *
 * @param {string} char
 * @returns {string|null}
 */
export function romanizeSyllable(char) {
  const code = char.codePointAt(0);
  if (code === undefined || code < HANGUL_BASE || code > HANGUL_LAST) return null;

  const offset = code - HANGUL_BASE;
  const cho = Math.floor(offset / (JUNG_COUNT * JONG_COUNT));
  const jung = Math.floor(offset / JONG_COUNT) % JUNG_COUNT;
  const jong = offset % JONG_COUNT;
  return KOREAN_JAMO.cho[cho] + KOREAN_JAMO.jung[jung] + KOREAN_JAMO.jong[jong];
}

/**
 * The romaji of a run of kana, or null if it holds anything that is not kana.
 *
 * Returns null rather than a partial conversion, because a string mixing kana
 * with kanji cannot be fully romanized: the kanji would come through unchanged,
 * which reads as a bug in the annotation rather than as missing data.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function romanizeKana(text) {
  if (!text) return null;

  const chars = [...text];
  /** Accumulated romaji, one piece per emitted mora. */
  const out = [];
  let pendingSokuon = false;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (!/[\\u3040-\\u30ff]/u.test(char)) return null;

    // ー is the long-vowel mark: it lengthens the previous vowel, which romaji
    // writes by repeating it.
    //
    // It also absorbs a preceding っ rather than letting it double the vowel it
    // sits on: ぼーっと is 'bootto' under a naive order, and 'bo-tto' in practice,
    // where the ー lengthens the ぼ and the っ doubles the と. Consuming the flag
    // here is what keeps the two marks from interacting wrongly.
    if (char === 'ー') {
      pendingSokuon = false;
      const last = out[out.length - 1] ?? '';
      const vowel = last.match(/[aeiou](?!.*[aeiou])/);
      if (vowel) out.push(vowel[0]);
      continue;
    }

    // っ (sokuon) doubles the NEXT consonant (がっこう -> gakkou). Noted here and
    // applied when the next mora is emitted, because there is nothing yet to
    // double.
    //
    // **Both scripts.** The hiragana and katakana forms are different code points
    // (っ and ッ), and checking only the hiragana one silently failed on every
    // katakana word: カッと came out \`kato\` while がっこう came out \`gakkou\`.
    // Caught by comparing against the reference across the whole corpus rather
    // than by the hand-picked examples, which were all hiragana.
    if (char === 'っ' || char === 'ッ') {
      pendingSokuon = true;
      continue;
    }

    // A contracted pair, looked up BEFORE the single row, so きゅ is one mora
    // rather than き followed by ゅ.
    const pair = KANA_CONTRACTED[char + (chars[i + 1] ?? '')];

    // ん is a full mora but has no vowel, and romaji writes an apostrophe before a
    // following vowel or y-sound so it can be told from a digraph: ぼんやり is
    // \`bon'yari\`, not \`bonyari\`, which would read as ぼにゃり. The apostrophe is
    // only needed before a vowel, which is why this is one special case rather
    // than a rule about every mora.
    //
    // Both scripts, for the same reason as the sokuon above: ん and ン are
    // different code points and checking one silently ignored half the corpus.
    if (char === 'ん' || char === 'ン') {
      const next = chars[i + 1] ?? '';
      const nextRomaji = KANA_CONTRACTED[next + (chars[i + 2] ?? '')] ?? KANA_ROMAJI[next] ?? '';
      const needsMark = /^[aeiouy]/.test(nextRomaji);
      // A doubled っ before ん is meaningless, but consume it rather than drop it
      // silently, so the state cannot leak into the next mora.
      pendingSokuon = false;
      out.push(needsMark ? "n'" : 'n');
      continue;
    }

    if (pair !== undefined) {
      // A っ before a contracted pair doubles the pair's own consonant: しょっちゅう
      // is 'shotchuu', not 'shocchuu', because the doubled sound is the ち inside
      // ちゅ. doubleOnset handles the digraph by name.
      out.push(pendingSokuon ? doubleOnset(pair) : pair);
      pendingSokuon = false;
      i++;
      continue;
    }

    const row = KANA_ROMAJI[char];
    if (row === undefined) return null;
    out.push(pendingSokuon ? doubleOnset(row) : row);
    pendingSokuon = false;
  }

  // A trailing っ with nothing to double emits nothing, which is what it sounds
  // like at the end of a word.
  return out.join('') || null;
}

/**
 * The romaji of a mora with its consonant doubled by a preceding っ.
 *
 * The digraphs are handled by name because their romanization does not start with
 * the doubled letter: ち is \`chi\` and っち is \`tchi\`, し is \`shi\` and っし is
 * \`sshi\`. Taking the first letter of the row would give \`cchi\` and \`sshi\` on a
 * naive rule, one of which is right by accident.
 *
 * @param {string} romaji
 * @returns {string}
 */
function doubleOnset(romaji) {
  // The sokuon doubles the onset CONSONANT, and the romanization spells two of
  // them in a way where the doubled letter is not the first one:
  //
  //   か is 'ka'  and っか is 'kka'    first letter, doubled
  //   し is 'shi' and っし is 'sshi'   first letter, doubled
  //   ち is 'chi' and っち is 'tchi'   the 't', NOT the 'c'
  //   つ is 'tsu' and っつ is 'ttsu'   the 't'
  //
  // So: prefix the doubled consonant, and the consonant is 't' for the two a reader
  // hears as /t/. Everything else uses its own first letter, which is also right
  // for 'sh'.
  const consonant = /^(ch|ts)/.test(romaji) ? 't' : romaji.charAt(0);
  return consonant + romaji;
}

/**
 * The romaji of a run of Hangul, or null if it holds anything that is not Hangul.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function romanizeHangul(text) {
  if (!text) return null;
  let out = '';
  for (const char of text) {
    const syllable = romanizeSyllable(char);
    if (syllable === null) return null;
    out += syllable;
  }
  return out || null;
}
`;

await writeFile(OUT, source, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`  korean jamo: ${korean.cho.length}/${korean.jung.length}/${korean.jong.length}`);
console.log(`  kana rows  : ${Object.keys(kana).length}`);
