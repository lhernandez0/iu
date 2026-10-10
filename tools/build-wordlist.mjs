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
 * WHY AN INDEX. The list dropdown is populated from the dictionary,
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
 * not know about it drift apart the moment either one changes, which is exactly
 * what happened once already, when a rebuild silently dropped `defaultThreshold`.
 * A field the artefact carries must be a field this script emits.
 *
 * Nothing here knows what HSK or JLPT is. A list has an id, a label, a language
 * and a level count; that is the entire contract.
 *
 * --- Chinese source -----------------------------------------------------------
 * https://github.com/TeaPearce/chinese-english-dictionary
 *   data/parsed_hsk_enriched.json, 11,470 usable entries, CC BY-SA 4.0, derived
 *   from CC-CEDICT, with HSK levels from the official MOE HSK 3.0 word list
 *   (upstream file data/hsk31-words-pleco.txt; "Pleco" in that filename is the
 *   OCR tool, not the author).
 *
 *   PINNED SOURCE, the input is not committed and is not fetched by this script,
 *   so a rebuild needs the exact revision:
 *     commit  a9aea223269eb9820590e5bca783eb299c317439  (2026-08-27)
 *     blob    7562130dea9284b99c86c9e8a5b8fe0a2cc003a1
 *     sha256  e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10
 *
 * --- Japanese sources ---------------------------------------------------------
 * Definitions/readings: JMdict (EDRDG, Jim Breen) via scriptin/jmdict-simplified
 *   release 3.6.2+20261005200550, asset jmdict-eng-common-…json.zip
 *     sha256  956cb65b95d12d2b81fa550716d53163dbd3c70ca171a9c7dce97d7238c9d87a
 *            (of the ZIP, which is the distributed artefact)
 *   CC BY-SA 4.0. EDRDG is the origin; the conversion is a derived distribution.
 * Levels: jamsinclair/open-anki-jlpt-decks (MIT)
 *     commit  1ad66734417aca9dbcca6b2d5ee440cb13ab3ba0
 *   `src/n1.csv … src/n5.csv`, level read from the `JLPT_N*` tag.
 *
 * --- Korean sources -----------------------------------------------------------
 * Levels (NIKL A/B/C and TOPIK I/II):
 *   julienshim/combined_korean_vocabulary_list, `results.tsv`
 *     sha256  bb5789e46d818842ed6cc15c7946805ad1aed9fd1d0912d884cc48a8556b9a3c
 *   The aggregator is MIT for its CODE and says outright that it does not host
 *   the source lists. The level data is NIKL's 한국어 학습용 어휘 목록 and TOPIK's
 *   어휘 목록, and the NIKL page grants KOGL Type 1 (공공누리 제1유형), which
 *   permits commercial and derivative use WITH attribution.
 * Definitions/readings:
 *   Amulopapa67/open-yonsei-korean-vocabulary, `vol-01.json … vol-06.json`,
 *   release v0.1.0. Data is CC BY-SA 3.0; code MIT. A community companion to the
 *   six-volume Yonsei course, and NOT affiliated with Yonsei University.
 *
 * What it emits, and why in this shape:
 *
 *   - THREE keyed objects per dictionary rather than one array of records.
 *     `levels` holds only the numbers per list, so a word with no level is simply
 *     absent from it. That is what makes "definition yes, colour no" fall out for
 *     free instead of needing a null-level branch.
 *   - Both HSK numberings, kept separate and selectable. They are alternative
 *     numberings of the same vocabulary, not a merged truth.
 *   - Japanese and Korean reuse the entry shape `{p, m, t, pos}` rather than
 *     inventing a second one: `p` is the reading (pinyin, kana, or a Korean
 *     pronunciation), `t` is unused and empty.
 *   - `meta.sources` is a LIST, one entry per upstream, rather than the flat
 *     `sourceCommit`/`sourceTag`/`levelsCommit` scalars this used to carry. Those
 *     encoded the number of sources in their NAMES, which worked while each
 *     language had one and had to be extended for Japanese's second. Korean's two
 *     upstreams are peers (levels from one, definitions from the other), so there
 *     is no "the source" to hang a scalar on.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../src/learn/data');
const CHINESE_OUT = join(DATA_DIR, 'chinese.json');
const JAPANESE_OUT = join(DATA_DIR, 'japanese.json');
const KOREAN_OUT = join(DATA_DIR, 'korean.json');
const INDEX_OUT = join(DATA_DIR, 'index.json');

/** @param {string} flag @returns {string|null} */
function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

const zhSource = arg('--zh');
const jaSource = arg('--ja');
const jlptDir = arg('--jlpt');
const koSource = arg('--ko');
const koYonseiDir = arg('--ko-yonsei');

if (!zhSource && !jaSource && !koSource) {
  console.error('usage: node tools/build-wordlist.mjs --zh <parsed_hsk_enriched.json>');
  console.error('       node tools/build-wordlist.mjs --ja <jmdict.json> --jlpt <dir>');
  console.error('       node tools/build-wordlist.mjs --ko <results.tsv> --ko-yonsei <dir>');
  console.error('       node tools/build-wordlist.mjs --zh … --ja … --jlpt … --ko … --ko-yonsei …   (all)');
  process.exit(1);
}
if (jaSource && !jlptDir) {
  console.error('--ja needs --jlpt <dir> holding n1.csv … n5.csv');
  process.exit(1);
}
if ((koSource && !koYonseiDir) || (koYonseiDir && !koSource)) {
  console.error('--ko needs --ko-yonsei <dir> holding vol-01.json … vol-06.json, and vice versa');
  process.exit(1);
}

/**
 * The word lists a learner can choose between.
 *
 * `levelCount` is what the colour ramp divides by, so it has to be the real count
 * for the list rather than the highest level present.
 *
 * There is deliberately NO starting level here. Where marking begins is the
 * learner's own choice, remembered per list by the app, the only thing this data
 * could say about someone it has never seen read is a guess about them. It used to
 * carry one, and it was `4` for both HSK lists: the level of whoever built it,
 * shipped as a constant to everyone.
 *
 * `levelNames` is what the level is CALLED, easiest first. The stored level is an
 * ordered 1..N so the ramp and the threshold comparison work the same for every
 * list; the NAME is the only part that differs, and it differs a lot, HSK counts
 * 1..9 getting harder, JLPT counts N5..N1 getting harder, so the same internal
 * "2" is "2" in one list and "N4" in the other. Printing the internal number as
 * though it were the list's own name is what made 私 (JLPT N5, internal 1) show as
 * "JLPT 1", which a reader takes for N1, the hardest level, on the easiest word.
 */
const CHINESE_LISTS = [
  { id: 'hsk2_0', label: 'HSK 2.0', language: 'zh', levelCount: 6, levelNames: ['1', '2', '3', '4', '5', '6'], field: 'hsk2_0' },
  { id: 'hsk3_0', label: 'HSK 3.0', language: 'zh', levelCount: 9, levelNames: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], field: 'hsk3_0' },
];

// JLPT is ONE list with five levels, not five lists, mirroring how HSK 2.0 is one
// list with six. Numbering is N5=1 (easiest) … N1=5, so the ramp runs cool→warm
// easy→hard exactly as the HSK lists do. The internal number stays ascending so
// nothing downstream has to know JLPT counts backwards; only the NAME differs.
const JAPANESE_LISTS = [
  { id: 'jlpt', label: 'JLPT', language: 'ja', levelCount: 5, levelNames: ['N5', 'N4', 'N3', 'N2', 'N1'] },
];

/**
 * The Korean lists.
 *
 * TWO lists over one vocabulary, the way HSK 2.0 and HSK 3.0 are two numberings of
 * the same words. Source A tags every row with BOTH an NIKL 등급 and a TOPIK 수준,
 * so both are available at no extra cost, and they disagree often enough to be
 * worth offering separately.
 *
 * `topik` has TWO levels because the data has two: TOPIK I (초급) and TOPIK II
 * (중급, "from intermediate on"). The six TOPIK *grades* are score cutoffs from the
 * exam, not a classification of vocabulary, so they are not invented here. The
 * aggregator's own notes make the same point.
 *
 * `nikl` has THREE: A (beginner), B (intermediate), C (advanced).
 *
 * Both ascend 1..N as difficulty rises, which is what the ramp and the threshold
 * comparison require. The NAMES are what a learner reads, and neither numbering is
 * a bare digit, so `levelNames` matters here as much as it does for JLPT.
 */
const KOREAN_LISTS = [
  { id: 'topik', label: 'TOPIK', language: 'ko', levelCount: 2, levelNames: ['TOPIK I', 'TOPIK II'], field: 'topikLevel' },
  { id: 'nikl', label: 'NIKL', language: 'ko', levelCount: 3, levelNames: ['A', 'B', 'C'], field: 'niklLevel' },
];

/**
 * One upstream, named as the artefact rather than as the repository it came from.
 *
 * Every field is optional except `name` and `licence`, because the sources genuinely
 * differ in what can be pinned: a git host gives a commit, a release gives a tag and
 * a content hash, and an original spreadsheet distributed as a file gives neither.
 * Emitting an empty string for what a source does not have would be worse than
 * omitting it, since the licence test can then assert "hash present AND well formed"
 * rather than "hash present, but '' is a string".
 *
 * @typedef {Object} SourceRef
 * @property {string} name        What it is, in words a reader can search on.
 * @property {string} licence     SPDX or a named public licence, exactly as upstream states it.
 * @property {string} [url]
 * @property {string} [commit]    A git revision, when the source is a repo.
 * @property {string} [tag]       A release identifier.
 * @property {string} [sha256]    Content hash, 64 hex, when a file can be hashed.
 * @property {string} [note]      What this source contributes, and any caveat.
 */

/**
 * The fields the app reads off a list, in the shape both builders emit.
 *
 * Shared so the Chinese and Japanese payloads cannot drift, and so a field added
 * here cannot be emitted by one builder and forgotten by the other, which is how
 * `defaultThreshold` came to be hand-added to the JSON and then silently dropped
 * by the next rebuild.
 *
 * @param {{id: string, label: string, language: string, levelCount: number, levelNames: string[]}} list
 * @param {Record<string, number>} levelsForList
 * @returns {object}
 */
const listMeta = (list, levelsForList) => ({
  id: list.id,
  label: list.label,
  language: list.language,
  levelCount: list.levelCount,
  levelNames: list.levelNames,
  levelled: Object.keys(levelsForList).length,
});

/**
 * The payload's `meta`, from the parts every builder has.
 *
 * The licence shown to a user is the MOST RESTRICTIVE of the sources, because the
 * artefact as a whole must satisfy every one of them: Korean definitions are
 * CC BY-SA 3.0 while the level list is KOGL Type 1, and the combined document is
 * offered under 3.0 as a result. Stated as a derived value rather than a third
 * hand-set string, so it cannot disagree with the list above it.
 *
 * @param {{sources: SourceRef[], compiledBy: string, wordCount: number, note: string}} parts
 * @returns {object}
 */
function buildMeta({ sources, compiledBy, wordCount, note }) {
  // Ordered most to least restrictive for the choice below. CC BY-SA 4.0 and 3.0
  // are the same obligation at different version numbers, so the lower version
  // wins when both appear, which is what share-alike compatibility requires.
  const ORDER = ['CC BY-SA 3.0', 'CC BY-SA 4.0', 'CC BY 4.0', 'KOGL Type 1', 'MIT'];
  const found = sources.map((s) => s.licence).filter((l) => ORDER.includes(l));
  const licence = ORDER.find((l) => found.includes(l)) ?? sources[0].licence;

  return {
    // Kept as plain strings for the licence test and for anything reading the
    // artefact without understanding `sources`. `compiledBy` names the people
    // whose work this is, which is an attribution requirement, not a courtesy.
    licence,
    compiledBy,
    sources,
    wordCount,
    note,
  };
}

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
    meta: buildMeta({
      sources: [
        {
          name: 'CC-CEDICT via TeaPearce/chinese-english-dictionary',
          licence: 'CC BY-SA 4.0',
          url: 'https://github.com/TeaPearce/chinese-english-dictionary',
          commit: 'a9aea223269eb9820590e5bca783eb299c317439',
          sha256: 'e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10',
          note: 'data/parsed_hsk_enriched.json. CC-CEDICT definitions, with HSK levels from the official MOE HSK 3.0 word list (upstream file data/hsk31-words-pleco.txt, where "Pleco" names the OCR tool, not the author).',
        },
      ],
      wordCount: Object.keys(words).length,
      compiledBy: 'Tim Pearce (TeaPearce/chinese-english-dictionary)',
      note: 'Unlevelled words have a definition but no level.',
    }),
    lists: CHINESE_LISTS.map((list) => listMeta(list, levels[list.id])),
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
 * corrupt exactly the rows with punctuation, which is most of the interesting
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
 * stripping, a naive join silently loses about 10% of levels, hundreds of words
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
    //   tagged `rK` (rare kanji), a spelling nobody has written in a century and
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
    // whichever entry was written last, a confidently wrong meaning, which is
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
    // `私` resolves to わたし, the reading a learner will actually meet, while
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
    meta: buildMeta({
      sources: [
        {
          name: 'JMdict (EDRDG, Jim Breen) via scriptin/jmdict-simplified',
          licence: 'CC BY-SA 4.0',
          url: 'https://github.com/scriptin/jmdict-simplified',
          tag: '3.6.2+20261005200550',
          sha256: '956cb65b95d12d2b81fa550716d53163dbd3c70ca171a9c7dce97d7238c9d87a',
          note: 'jmdict-eng-common, the "common" subset. Hash is of the ZIP, which is the distributed artefact. Definitions and readings.',
        },
        {
          name: 'open-anki-jlpt-decks (Jamie Sinclair)',
          licence: 'MIT',
          url: 'https://github.com/jamsinclair/open-anki-jlpt-decks',
          commit: '1ad66734417aca9dbcca6b2d5ee440cb13ab3ba0',
          note: 'src/n1.csv … src/n5.csv. JLPT levels only, read from the JLPT_N* tag.',
        },
      ],
      wordCount: Object.keys(words).length,
      compiledBy: 'EDRDG (JMdict definitions and readings); Jamie Sinclair (JLPT levels)',
      note: 'Words absent from JMdict "common" have no definition. Inflected forms do not match: the matcher is exact against headwords.',
    }),
    lists: JAPANESE_LISTS.map((list) => listMeta(list, levels[list.id])),
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
 * Split a TSV line on tabs, keeping empty fields.
 *
 * The source is tab-separated and its `explanation` field holds semicolons and
 * commas but never a tab, so a plain split is correct. Written out rather than
 * inlined so the "tabs cannot appear inside a field" reasoning has one home.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitTsv(line) {
  return line.split('\t');
}

/**
 * The level source's join key for a word.
 *
 * NIKL disambiguates homographs with a trailing number: `가구03` and `가구04` are
 * the furniture and the household, two senses of one spelling. Our model has one
 * entry per spelling and the learner either knows the word or does not, so the
 * number is stripped and the senses merge. Measured on the source: 45.8% of rows
 * carry one.
 *
 * Only a trailing run of one or two digits is stripped. A numeral like `3학년`
 * ("third year") is a real spelling, and the anchor at the end is what leaves it
 * alone.
 *
 * @param {string} word
 * @returns {string}
 */
function stripHomographSuffix(word) {
  return word.replace(/\d{1,2}$/, '');
}

/**
 * The NIKL level for a cell, as an ascending 1..3, or null.
 *
 * A and C are the ends and B is the middle. A lookup rather than arithmetic on the
 * letter so it reads as the mapping it is, and so a fourth letter would produce
 * null rather than a wrong number.
 *
 * @param {string} cell
 * @returns {number|null}
 */
function niklLevel(cell) {
  const byName = { A: 1, B: 2, C: 3 };
  return byName[String(cell).trim().toUpperCase()] ?? null;
}

/**
 * The TOPIK level for a cell, as an ascending 1..2, or null.
 *
 * The source has two bands: 초급 (TOPIK I) and 중급 ("from intermediate on", TOPIK
 * II). This deliberately does not invent more. TOPIK's six exam grades are score
 * cutoffs, not a classification of vocabulary, so they cannot be derived from this
 * column without making them up, and the aggregator's own notes say the same.
 *
 * @param {string} cell
 * @returns {number|null}
 */
function topikLevel(cell) {
  const byName = { 초급: 1, 중급: 2 };
  return byName[String(cell).trim()] ?? null;
}

/**
 * Definitions and readings from the Yonsei companion, keyed by the word.
 *
 * FIRST VOLUME WINS, which is why the volumes are read in order and an existing key
 * is never replaced. The six volumes are a course, so the earliest volume a word
 * appears in is where the learner meets it, and that is the sense worth showing. A
 * word recurring later is revision, not a second definition.
 *
 * Only two fields are taken: `english` (the meaning) and `pronunciation` (text, on
 * 40.6% of rows). The source also carries `chinese`, `pos_zh`, `origin_type` and a
 * per-row `review_status`. None belong in a dictionary entry: `origin_type` is
 * etymology for a different UI, and `review_status` describes the source's own
 * confidence in its editing rather than anything a learner should see.
 *
 * @param {string} dir
 * @returns {Promise<Map<string, {m: string, p: string, pos: string}>>}
 */
async function readYonseiDefinitions(dir) {
  const byWord = new Map();

  for (let v = 1; v <= 6; v++) {
    const doc = JSON.parse(await readFile(join(dir, `vol-0${v}.json`), 'utf8'));
    for (const row of doc.rows ?? []) {
      const word = row.korean;
      if (!word) continue;
      if (byWord.has(word)) continue;
      byWord.set(word, {
        m: row.english ?? '',
        p: row.pronunciation ?? '',
        pos: row.pos ?? '',
      });
    }
  }

  return byWord;
}

/**
 * Korean: levels from NIKL and TOPIK, definitions from the Yonsei companion.
 *
 * The join is the whole problem, and it covers only 32% of the level list, because
 * the two sources describe different objects. The level list is dictionary lemmas;
 * the definition list is course vocabulary, which includes phrases, honorific
 * forms, particles and compounds (`안녕하십니까`, `에서`, `은행원`). Stripping verb
 * endings recovered 2 of 1,913 failures when measured, so this is not a morphology
 * problem and one line of stemming will not fix it. Match rate by volume runs 82%
 * in volume 1 down to 19% in volume 6, because beginner content is lemmas while
 * advanced content is expressions.
 *
 * THE UNJOINED WORDS STILL SHIP, with an empty `m`. This is the load-bearing
 * decision here. `indexDictionary()` builds `headwords` from the keys of `words`,
 * so a word present in `levels` but absent from `words` can never be marked at all:
 * 4,558 words would silently vanish from a Korean video with nothing to say why.
 * Emitting the entry keeps every levelled word markable, and the popover already
 * renders "No definition for this word yet." for an empty `m` (marks.js), so the
 * limit is visible to the learner rather than hidden.
 *
 * @param {string} sourcePath
 * @param {string} yonseiDirPath
 * @returns {Promise<object[]>}
 */
async function buildKorean(sourcePath, yonseiDirPath) {
  const tsv = await readFile(sourcePath, 'utf8');
  const definitions = await readYonseiDefinitions(yonseiDirPath);

  /** @type {Record<string, Record<string, number>>} */
  const levels = { topik: {}, nikl: {} };

  /** @type {Record<string, {p: string, m: string, t: string, pos: string}>} */
  const words = {};

  const dropped = { noWord: 0, noLevel: 0 };
  let suffixed = 0;
  let mergedSenses = 0;
  const joinedWords = new Set();

  const lines = tsv.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Drop the header, and any trailing blank the file may end with.
    if (i === 0 || !lines[i].trim()) continue;

    const [, rawWord, partOfSpeech, , , nikl, topik] = splitTsv(lines[i]);

    if (!rawWord) {
      dropped.noWord++;
      continue;
    }
    if (/\d{1,2}$/.test(rawWord)) suffixed++;
    const word = stripHomographSuffix(rawWord);

    // A row with no level at all cannot colour anything, and its definition, if the
    // join found one, would come from elsewhere. The current revision has none of
    // these, but the guard means a future one cannot introduce a word with no way
    // to be placed on the ramp.
    const ko = topikLevel(topik);
    const ni = niklLevel(nikl);
    if (ko === null && ni === null) {
      dropped.noLevel++;
      continue;
    }

    // EASIEST WINS across merged homograph senses, so a word is never placed higher
    // than any list says it is. The senses are one entry in our model, and taking
    // the harder of two would overstate what the learner needs.
    for (const [id, level] of [['topik', ko], ['nikl', ni]]) {
      if (level === null) continue;
      const existing = levels[id][word];
      if (existing === undefined) levels[id][word] = level;
      else if (level < existing) levels[id][word] = level;
      else mergedSenses++;
    }

    // The definition, from the other source. Absent is the common case and is not
    // an error: `m` stays empty and the word still marks.
    const found = definitions.get(word);
    if (found) joinedWords.add(word);

    // FIRST ROW WINS for the definition and reading. A word appears once per part of
    // speech in the level list (`일곱` is a numeral and a noun), and the entry is one
    // object, so the first row fills the fields and later rows contribute levels.
    if (!(word in words)) {
      // `explanation` is a collocation hint rather than a definition (`~에 가다`
      // for 가게, "to go to a shop") and is empty on 18% of rows. It is Korean
      // guidance for a Korean learner, so used as the meaning it would read as a
      // non-answer next to a real gloss, and it is not used.
      words[word] = {
        p: found?.p ?? '',
        m: found?.m ?? '',
        // Unused, as for Japanese. Korean has no second script for a word.
        t: '',
        pos: partOfSpeech ?? '',
      };
    }
  }

  const payload = {
    meta: buildMeta({
      sources: [
        {
          name: 'NIKL 한국어 학습용 어휘 목록 (National Institute of Korean Language) and TOPIK 어휘 목록, combined by julienshim/combined_korean_vocabulary_list',
          licence: 'KOGL Type 1',
          url: 'https://github.com/julienshim/combined_korean_vocabulary_list',
          sha256: 'bb5789e46d818842ed6cc15c7946805ad1aed9fd1d0912d884cc48a8556b9a3c',
          note: 'results.tsv. The aggregator is MIT for its code and states it does not host the source lists. NIKL publishes its list under KOGL Type 1 (공공누리 제1유형), which permits commercial and derivative use with attribution. Levels only; the `explanation` column is a collocation hint and is unused.',
        },
        {
          name: 'Open Yonsei Korean Vocabulary (Amulopapa67), a community companion to the six-volume Yonsei course, not affiliated with Yonsei University',
          licence: 'CC BY-SA 3.0',
          url: 'https://github.com/Amulopapa67/open-yonsei-korean-vocabulary',
          tag: 'v0.1.0',
          note: 'vol-01.json … vol-06.json. Definitions and text readings only. The project licenses its data CC BY-SA 3.0 and excludes textbook lessons, examples, audio and official artwork.',
        },
      ],
      wordCount: Object.keys(words).length,
      compiledBy: 'National Institute of Korean Language and TOPIK (levels); Open Yonsei Korean Vocabulary (definitions and readings)',
      note: 'Korean words are joined to definitions on the word. Where the join misses, the word still marks and has no definition, which the popover states. Homograph senses (가구03, 가구04) merge into one entry at the easiest level.',
    }),
    lists: KOREAN_LISTS.map((list) => listMeta(list, levels[list.id])),
    levels,
    words,
  };

  await writeFile(KOREAN_OUT, JSON.stringify(payload), 'utf8');

  const total = Object.keys(words).length;
  console.log(`wrote ${KOREAN_OUT}`);
  console.log(`  words: ${total}`);
  console.log(`  homograph-suffixed rows: ${suffixed}`);
  console.log(`  merged senses (easiest kept): ${mergedSenses}`);
  console.log(`  dropped (no word): ${dropped.noWord}`);
  console.log(`  dropped (no level): ${dropped.noLevel}`);
  console.log(`  joined to a definition: ${joinedWords.size} (${Math.round((joinedWords.size / total) * 100)}%)`);
  console.log(`  markable with no definition: ${total - joinedWords.size}`);
  console.log(`  topik levelled: ${Object.keys(levels.topik).length}`);
  console.log(`  nikl levelled: ${Object.keys(levels.nikl).length}`);

  return payload.lists;
}

/**
 * The list manifest: which lists exist, and which dictionary holds each one's
 * words. Small on purpose, the worker loads this eagerly so the dropdown can be
 * filled without parsing any word data.
 *
 * @param {object[]} lists
 * @returns {Promise<void>}
 */
async function writeIndex(lists) {
  const fileFor = { zh: 'chinese.json', ja: 'japanese.json', ko: 'korean.json' };
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
if (koSource) collected.push(...(await buildKorean(koSource, koYonseiDir)));

// Only rewrite the index when EVERY language is present. A partial run must not
// silently drop a language from the manifest, the app would then lose a list nobody
// asked to remove. Building one language at a time is a development convenience; the
// committed index has to describe what actually ships.
//
// Stated as "which are missing" rather than a chain of `&&`, so adding a fourth
// language here cannot leave the condition silently wrong the way `zh && ja` would
// have the moment Korean arrived.
const built = new Set(collected.map((list) => list.language));
const MISSING = ['zh', 'ja', 'ko'].filter((lang) => !built.has(lang));

if (MISSING.length === 0) {
  await writeIndex(collected);
} else {
  console.log(`note: not rewriting index.json, still missing: ${MISSING.join(', ')}`);
}
