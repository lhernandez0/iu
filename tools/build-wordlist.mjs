/**
 * Build the bundled word lists, and the index that names them.
 *
 * Run manually when the data changes; the output is committed. This is not part
 * of the extension and is never loaded by it.
 *
 *   node tools/build-wordlist.mjs --zh path/to/parsed_hsk_enriched.json
 *   node tools/build-wordlist.mjs --ja path/to/jmdict.json --jlpt path/to/dir
 *   node tools/build-wordlist.mjs --zh … --ja … --jlpt …      (both, one index)
 *
 * WHY AN INDEX. The list dropdown is populated from the dictionary —
 * `primeDictionary()` sets `availableLists` from `dictionary.lists`. With one
 * language that was fine. With two, the service worker would parse ~2.6MB of
 * JSON on every wake just to fill a dropdown, which is the cost `wordlist.js`
 * already warns about ("1.4MB of JSON.parse on each one would be felt"). So list
 * metadata lives in a small `index.json` the worker loads eagerly, and each
 * language's word data is loaded lazily when a list from it becomes active.
 *
 * Provenance travels with the data so the licence is discoverable from the
 * artefact itself, not only from this script. Generated here rather than
 * hand-written into the JSON, because a hand-edited field and a script that does
 * not know about it drift apart the moment either one changes — which is exactly
 * what happened once already, when a rebuild silently dropped `defaultThreshold`.
 * A field the artefact carries must be a field this script emits.
 *
 * Nothing here knows what HSK or JLPT is. A list has an id, a label, a language
 * and a level count; that is the entire contract.
 *
 * --- Chinese source -----------------------------------------------------------
 * https://github.com/TeaPearce/chinese-english-dictionary
 *   data/parsed_hsk_enriched.json — 11,470 usable entries, CC BY-SA 4.0, derived
 *   from CC-CEDICT, with HSK levels from the official MOE HSK 3.0 word list
 *   (upstream file data/hsk31-words-pleco.txt; "Pleco" in that filename is the
 *   OCR tool, not the author).
 *
 *   PINNED SOURCE — the input is not committed and is not fetched by this script,
 *   so a rebuild needs the exact revision:
 *     commit  a9aea223269eb9820590e5bca783eb299c317439  (2026-08-27)
 *     blob    7562130dea9284b99c86c9e8a5b8fe0a2cc003a1
 *     sha256  e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10
 *
 * --- Japanese sources ---------------------------------------------------------
 * Definitions/readings: JMdict (EDRDG, Jim Breen) via scriptin/jmdict-simplified
 *   release 3.6.2+20261005200550, asset jmdict-eng-common-…json.zip
 *     sha256  956cb65b95d12d2b81fa550716d53163dbd3c70ca171a9c7dce97d7238c9d87a
 *   CC BY-SA 4.0. EDRDG is the origin; the conversion is a derived distribution.
 * Levels: jamsinclair/open-anki-jlpt-decks (MIT)
 *     commit  1ad66734417aca9dbcca6b2d5ee440cb13ab3ba0
 *   `src/n1.csv … src/n5.csv`, level read from the `JLPT_N*` tag.
 *
 * What it emits, and why in this shape:
 *
 *   - THREE keyed objects per dictionary rather than one array of records.
 *     `levels` holds only the numbers per list, so a word with no level is simply
 *     absent from it. That is what makes "definition yes, colour no" fall out for
 *     free instead of needing a null-level branch.
 *   - Both HSK numberings, kept separate and selectable. They are alternative
 *     numberings of the same vocabulary, not a merged truth.
 *   - Japanese reuses the entry shape `{p, m, t, pos}` rather than inventing a
 *     second one: `p` is the reading (pinyin or kana), `t` is unused and empty.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../src/learn/data');
const CHINESE_OUT = join(DATA_DIR, 'chinese.json');
const JAPANESE_OUT = join(DATA_DIR, 'japanese.json');
const INDEX_OUT = join(DATA_DIR, 'index.json');

/** @param {string} flag @returns {string|null} */
function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

const zhSource = arg('--zh');
const jaSource = arg('--ja');
const jlptDir = arg('--jlpt');

if (!zhSource && !jaSource) {
  console.error('usage: node tools/build-wordlist.mjs --zh <parsed_hsk_enriched.json>');
  console.error('       node tools/build-wordlist.mjs --ja <jmdict.json> --jlpt <dir>');
  console.error('       node tools/build-wordlist.mjs --zh … --ja … --jlpt …   (both)');
  process.exit(1);
}
if (jaSource && !jlptDir) {
  console.error('--ja needs --jlpt <dir> holding n1.csv … n5.csv');
  process.exit(1);
}

/**
 * The word lists a learner can choose between.
 *
 * `levelCount` is what the colour ramp divides by, so it has to be the real count
 * for the list rather than the highest level present.
 *
 * `defaultThreshold` is the level marking STARTS at for this list. It is per list
 * because a threshold is relative: 4 means "upper intermediate" in a 6-level list
 * and something else in a 9-level one.
 */
const CHINESE_LISTS = [
  { id: 'hsk2_0', label: 'HSK 2.0', language: 'zh', levelCount: 6, defaultThreshold: 4, field: 'hsk2_0' },
  { id: 'hsk3_0', label: 'HSK 3.0', language: 'zh', levelCount: 9, defaultThreshold: 4, field: 'hsk3_0' },
];

// JLPT is ONE list with five levels, not five lists — mirroring how HSK 2.0 is one
// list with six. Numbering is N5=1 (easiest) … N1=5, so the ramp runs cool→warm
// easy→hard exactly as the HSK lists do.
const JAPANESE_LISTS = [
  { id: 'jlpt', label: 'JLPT', language: 'ja', levelCount: 5, defaultThreshold: 3 },
];

/** @returns {Promise<object[]>} */
async function buildChinese(sourcePath) {
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));

  /** @type {Record<string, Record<string, string>>} */
  const levels = {};
  for (const list of CHINESE_LISTS) levels[list.id] = {};

  /** @type {Record<string, {p: string, m: string, t: string, pos: string}>} */
  const words = {};

  const dropped = { noSimplified: 0, noMeaning: 0 };

  for (const entry of source) {
    const word = entry.simplified;
    if (!word) {
      dropped.noSimplified++;
      continue;
    }

    // A word with no meaning is useless for hover. There were none in the source,
    // but the guard means a future revision cannot silently introduce them.
    if (!entry.meaning) {
      dropped.noMeaning++;
      continue;
    }

    // Short keys on purpose: these repeat 11k times and gzip does not help the
    // key names as much as it helps the values.
    words[word] = {
      p: entry.pinyin ?? '',
      m: entry.meaning,
      t: entry.traditional ?? '',
      pos: entry.pos ?? '',
    };

    for (const list of CHINESE_LISTS) {
      const level = entry[list.field];
      // Absent rather than null. This is the "colour no" case.
      if (typeof level === 'number') levels[list.id][word] = level;
    }
  }

  const payload = {
    meta: {
      source: 'CC-CEDICT via TeaPearce/chinese-english-dictionary',
      compiledBy: 'Tim Pearce (TeaPearce/chinese-english-dictionary)',
      licence: 'CC BY-SA 4.0',
      sourceCommit: 'a9aea223269eb9820590e5bca783eb299c317439',
      sourceSha256: 'e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10',
      note: 'HSK levels from the official MOE HSK 3.0 word list (via TeaPearce data/hsk31-words-pleco.txt; "Pleco" there is the OCR tool, not the author). Unlevelled words have a definition but no level.',
      wordCount: Object.keys(words).length,
    },
    lists: CHINESE_LISTS.map(({ id, label, language, levelCount, defaultThreshold }) => ({
      id,
      label,
      language,
      levelCount,
      levelled: Object.keys(levels[id]).length,
      defaultThreshold,
    })),
    levels,
    words,
  };

  await writeFile(CHINESE_OUT, JSON.stringify(payload), 'utf8');

  console.log(`wrote ${CHINESE_OUT}`);
  console.log(`  words: ${Object.keys(words).length}`);
  console.log(`  dropped (no simplified): ${dropped.noSimplified}`);
  console.log(`  dropped (no meaning): ${dropped.noMeaning}`);
  for (const list of CHINESE_LISTS) {
    console.log(`  ${list.id} levelled: ${Object.keys(levels[list.id]).length}`);
  }

  return payload.lists;
}

/**
 * A CSV parser that respects quoted fields.
 *
 * The JLPT files quote any meaning containing a comma and escape an embedded
 * quote by doubling it. Splitting on commas would work on the happy path and
 * corrupt exactly the rows with punctuation — which is most of the interesting
 * ones.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Candidate dictionary keys for a JLPT cell.
 *
 * A cell may hold several alternatives separated by `;` (`足; 脚`, `いい; よい`)
 * and may carry a `～` prefix for counters (`～円`). Without splitting and
 * stripping, a naive join silently loses about 10% of levels — hundreds of words
 * that look undefined but are simply spelled differently here than in the word
 * list.
 *
 * @param {string} cell
 * @returns {string[]}
 */
function jlptKeys(cell) {
  return String(cell)
    .split(';')
    .map((part) => part.replace(/[～~\s]/g, '').replace(/\(.*?\)/g, '').trim())
    .filter(Boolean);
}

/**
 * Level lookup from the JLPT CSVs: candidate key -> level (1=N5 … 5=N1).
 *
 * Keys on BOTH the expression and the reading column, because the CSV's
 * expression may be kana while the word list keys on kanji, and vice versa.
 * Matching either maximises coverage; unmatched words get a definition and no
 * level, which is the existing, correct behaviour.
 *
 * @param {string} dir
 * @returns {Promise<Map<string, number>>}
 */
async function readJlptLevels(dir) {
  const levels = new Map();

  // Easiest first, so an N5 word that also appears in a harder list keeps its
  // easier level.
  for (const n of [5, 4, 3, 2, 1]) {
    const csv = await readFile(join(dir, `n${n}.csv`), 'utf8');
    const rows = parseCsv(csv).slice(1); // drop the header
    const level = 6 - n; // N5 -> 1 (easiest) … N1 -> 5
    for (const row of rows) {
      for (const key of [...jlptKeys(row[0] ?? ''), ...jlptKeys(row[1] ?? '')]) {
        if (!levels.has(key)) levels.set(key, level);
      }
    }
  }

  return levels;
}

/** @returns {Promise<object[]>} */
async function buildJapanese(sourcePath, jlptDirPath) {
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const levelLookup = await readJlptLevels(jlptDirPath);

  /** @type {Record<string, Record<string, number>>} */
  const levels = { jlpt: {} };

  /** @type {Record<string, {p: string, m: string, t: string, pos: string}>} */
  const words = {};

  const dropped = { noExpression: 0, noGloss: 0 };
  /** Expression keys that occurred in more than one JMdict entry; first wins. */
  const collisions = new Set();
  let kanaOnly = 0;
  let multiForm = 0;

  for (const entry of source.words ?? []) {
    // Which form to key on. This is the form people actually WRITE, and getting
    // it wrong is quiet: the word simply never matches.
    //
    //   `とても` is the case that exposed it. Its only kanji form is `迚も`,
    //   tagged `rK` (rare kanji) — a spelling nobody has written in a century and
    //   that appears in no transcript. Keying on it put an unusable spelling in
    //   the index while the word that appears in every other sentence was absent.
    //
    //   JMdict says which form is which, so this asks rather than guesses:
    //     - drop forms tagged `rK` (rare kanji) or `rk` (rare kana);
    //     - prefer `common` forms;
    //     - fall back to kana when no usable kanji is left.
    //
    // Kana is NOT added as an extra key for entries that do have kanji, on
    // purpose: `はし` is 橋/箸/端, and one shared kana key would resolve to
    // whichever entry was written last — a confidently wrong meaning, which is
    // worse than no mark.
    const RARE = new Set(['rK', 'rk']);
    const usable = (forms) => (forms ?? []).filter((f) => !(f.tags ?? []).some((t) => RARE.has(t)));
    const texts = (forms) => usable(forms).map((f) => f.text).filter(Boolean);
    const common = (forms) => usable(forms).filter((f) => f.common).map((f) => f.text).filter(Boolean);

    const kanjiTexts = texts(entry.kanji);
    const commonKanji = common(entry.kanji);
    const kanaTexts = texts(entry.kana);
    const commonKana = common(entry.kana);

    // Common kanji first so the primary reading pairs with the primary spelling,
    // then any other usable kanji so `脚` resolves as well as `足`.
    const expressions = commonKanji.length
      ? [...commonKanji, ...kanjiTexts.filter((t) => !commonKanji.includes(t))]
      : commonKana.length
        ? [commonKana[0]]
        : kanaTexts.length
          ? [kanaTexts[0]]
          : [];

    if (!expressions.length) {
      dropped.noExpression++;
      continue;
    }
    if (!entry.kanji?.length) kanaOnly++;
    if (expressions.length > 1) multiForm++;

    // The reading the learner sees. Prefer the common kana: kana order in JMdict
    // is not frequency, so `kana[0]` gave 私 the reading あたし rather than わたし.
    const reading = commonKana[0] ?? kanaTexts[0] ?? '';
    const sense = entry.sense?.[0];
    const gloss = (sense?.gloss ?? [])
      .filter((g) => g.lang === 'eng')
      .map((g) => g.text)
      .join('; ');
    if (!gloss) {
      dropped.noGloss++;
      continue;
    }
    const pos = (sense?.partOfSpeech ?? []).join(',');

    // One entry PER EXPRESSION, so `足` and `脚` each resolve. The gloss is
    // duplicated across them: it keeps the schema unchanged, and it means
    // `lookup()` works for every form with no new code path.
    //
    // COLLISIONS ARE REAL AND EXPECTED. Japanese has homographs that JMdict
    // splits into separate entries: `私` is one entry for わたし and another for
    // あたし; `一時` is いちじ ("one o'clock") and いっとき ("for a while"). 156
    // expression keys occur in more than one entry.
    //
    // FIRST WINS, deliberately. JMdict lists entries roughly common-first, so
    // `私` resolves to わたし — the reading a learner will actually meet — while
    // last-wins gave あたし. Merging the glosses instead was rejected: several
    // unrelated senses concatenated reads as one confusing definition, and the
    // hover popover has a fixed narrow width. Overwrites are counted so this
    // stays visible rather than silent.
    for (const expression of expressions) {
      if (expression in words) {
        collisions.add(expression);
        continue;
      }
      words[expression] = { p: reading, m: gloss, t: '', pos };

      const level = levelLookup.get(expression) ?? levelLookup.get(reading);
      if (typeof level === 'number') levels.jlpt[expression] = level;
    }
  }

  const payload = {
    meta: {
      source: 'JMdict (EDRDG, Jim Breen) via scriptin/jmdict-simplified',
      compiledBy: 'EDRDG (JMdict definitions and readings); Jamie Sinclair (JLPT levels)',
      licence: 'CC BY-SA 4.0',
      sourceTag: '3.6.2+20261005200550',
      sourceSha256: '956cb65b95d12d2b81fa550716d53163dbd3c70ca171a9c7dce97d7238c9d87a',
      levelsCommit: '1ad66734417aca9dbcca6b2d5ee440cb13ab3ba0',
      note: 'Definitions and readings from JMdict (CC BY-SA 4.0, EDRDG); JLPT levels from open-anki-jlpt-decks (MIT). Kana-initial words cannot be marked by the current segmenter, and words absent from JMdict "common" have no definition.',
      wordCount: Object.keys(words).length,
    },
    lists: JAPANESE_LISTS.map(({ id, label, language, levelCount, defaultThreshold }) => ({
      id,
      label,
      language,
      levelCount,
      levelled: Object.keys(levels[id]).length,
      defaultThreshold,
    })),
    levels,
    words,
  };

  await writeFile(JAPANESE_OUT, JSON.stringify(payload), 'utf8');

  console.log(`wrote ${JAPANESE_OUT}`);
  console.log(`  words: ${Object.keys(words).length}`);
  console.log(`  kana-only entries: ${kanaOnly}`);
  console.log(`  multi-form entries: ${multiForm}`);
  console.log(`  dropped (no expression): ${dropped.noExpression}`);
  console.log(`  dropped (no gloss): ${dropped.noGloss}`);
  console.log(`  homograph collisions (first wins): ${collisions.size}`);
  console.log(`  jlpt levelled: ${Object.keys(levels.jlpt).length}`);

  return payload.lists;
}

/**
 * The list manifest: which lists exist, and which dictionary holds each one's
 * words. Small on purpose — the worker loads this eagerly so the dropdown can be
 * filled without parsing any word data.
 *
 * @param {object[]} lists
 * @returns {Promise<void>}
 */
async function writeIndex(lists) {
  const fileFor = { zh: 'chinese.json', ja: 'japanese.json' };
  const dictionaries = {};
  for (const list of lists) {
    dictionaries[list.language] = `src/learn/data/${fileFor[list.language]}`;
  }

  const index = {
    meta: {
      note: 'Generated by tools/build-wordlist.mjs. Maps lists to the dictionary holding their words.',
      generatedAt: new Date().toISOString(),
    },
    dictionaries,
    lists: lists.map((list) => ({ ...list, dictionary: list.language })),
  };

  await writeFile(INDEX_OUT, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(`wrote ${INDEX_OUT}`);
  console.log(`  lists: ${lists.map((l) => l.id).join(', ')}`);
}

// --- Run ---------------------------------------------------------------------

const collected = [];

if (zhSource) collected.push(...(await buildChinese(zhSource)));
if (jaSource) collected.push(...(await buildJapanese(jaSource, jlptDir)));

// Only rewrite the index when BOTH languages are present. A partial run must not
// silently drop a language from the manifest — the app would then lose a list
// nobody asked to remove. Building one language at a time is a development
// convenience; the committed index has to describe what actually ships.
if (zhSource && jaSource) {
  await writeIndex(collected);
} else {
  console.log('note: not rewriting index.json — build both languages to update it');
}
