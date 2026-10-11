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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { romanize } from 'koroman';

const here = dirname(fileURLToPath(import.meta.url));

/** @param {string} flag @returns {string|null} */
function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

/**
 * Where the built files go.
 *
 * Overridable because the verification script rebuilds into a scratch directory
 * and compares: a check that verified the committed data by OVERWRITING it would
 * destroy the evidence exactly when it found the problem it exists to find.
 */
const OUT_DIR = arg('--out') ? resolve(arg('--out')) : resolve(here, '../src/learn/data');
const CHINESE_OUT = join(OUT_DIR, 'chinese.json');
const JAPANESE_OUT = join(OUT_DIR, 'japanese.json');
const KOREAN_OUT = join(OUT_DIR, 'korean.json');
const INDEX_OUT = join(OUT_DIR, 'index.json');

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
  console.error('');
  console.error('  --out <dir>   write there instead of src/learn/data, for verification runs');
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
 * TWO lists, from two sources that are complementary rather than redundant. Measured
 * over their union (7,738 words) they overlap by only about 25%: NIKL contributes
 * 1,019 words the other does not place, Yonsei 1,913. Keeping both is what recovers
 * those 2,932 words.
 *
 * `nikl` is a graded lemma list with THREE levels: A (beginner), B (intermediate),
 * C (advanced).
 *
 * `yonsei` is a six-volume course, and its volume is used as the level. That is a
 * deliberate choice, not a convenience: measured, mean difficulty rises at EVERY
 * volume on both external measures, so the course ordering is a real difficulty
 * ordering rather than a table of contents. It is also the only list whose words all
 * carry a definition, since it is the source of them.
 *
 * TOPIK is not offered, and that is a licence decision. Its terms of use reserve the
 * rights a shipped dictionary would need; see the note in `buildKorean`.
 *
 * Both ascend 1..N as difficulty rises, which is what the ramp and the threshold
 * comparison require. The NAMES are what a learner reads, so `levelNames` matters
 * as much here as it does for JLPT.
 */
const KOREAN_LISTS = [
  { id: 'nikl', label: 'NIKL', language: 'ko', levelCount: 3, levelNames: ['A', 'B', 'C'], field: 'niklLevel' },
  { id: 'yonsei', label: 'Yonsei', language: 'ko', levelCount: 6, levelNames: ['1', '2', '3', '4', '5', '6'], field: 'yonseiLevel' },
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
 * Definitions, readings and COURSE LEVELS from the Yonsei companion.
 *
 * FIRST VOLUME WINS, which is why the volumes are read in order and an existing key
 * is never replaced. The six volumes are a course, so the earliest volume a word
 * appears in is where the learner meets it, and that is both the sense worth showing
 * and the difficulty to record. A word recurring later is revision, not a second
 * definition.
 *
 * The volume is used as a LEVEL, which is a deliberate decision and not a
 * convenience. Measured: mean difficulty rises at EVERY volume on both external
 * measures (NIKL and TOPIK), so the course ordering is a real difficulty ordering
 * and not just a table of contents. It is also NOT a restatement of NIKL: rank
 * correlation with NIKL is about 0.71, and the middle volumes overlap heavily, so
 * it carries information the levelled list does not.
 *
 * What this buys is coverage. Pages from this source carry a definition by
 * construction, so every word it contributes can be looked up, which is not true of
 * the level list, where most words have no gloss at all.
 *
 * Only three fields are taken: `english` (the meaning), `pronunciation` (text, on
 * 40.6% of rows), and `pos`. The source also carries `chinese`, `pos_zh`,
 * `origin_type` and a per-row `review_status`. None belong in a dictionary entry:
 * `origin_type` is etymology for a different UI, and `review_status` describes the
 * source's own confidence in its editing rather than anything a learner should see.
 *
 * @param {string} dir
 * @returns {Promise<Map<string, {m: string, p: string, pos: string, level: number}>>}
 */
async function readYonsei(dir) {
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
        level: v,
      });
    }
  }

  return byWord;
}

/**
 * A Korean entry, with the reading derived rather than copied.
 *
 * ## Why the reading is computed and not taken from the source
 *
 * The definition source carries a `pronunciation` field, and it is NOT a reading
 * in the sense the other two languages use. For Chinese `p` is pinyin and for
 * Japanese it is kana: both are written in a DIFFERENT script from the word, so a
 * learner who cannot yet read the script can use them. The Korean field is a Hangul
 * respelling (가깝다 -> 가깝따, 한국 -> 한ː국) which shows the sound changes but stays
 * in Hangul, so it is only useful to someone who already reads Hangul, which is the
 * person who needs it least. It is kept as-is in `s`, for reference.
 *
 * `p` is therefore generated with `koroman`, an MIT implementation of the
 * National Institute of Korean Language's Revised Romanization, including the
 * sound-change rules. It matches all 25 of the standard's own published examples,
 * and a naive character-mapping romanizer matches only 11 of them, because Revised
 * Romanization is a set of rules and not a character map.
 *
 * The WORD is the input, never the respelling. The library applies the sound rules
 * itself, so feeding it an already-rewritten spelling applies them twice: 학생
 * romanizes to `haksaeng`, while its respelling 학쌩 romanizes to `hakssaeng`.
 *
 * ## The two forms, and why both are stored
 *
 * Romanization has two modes and they are different questions:
 *
 *   transcription (sound)      종로 -> `Jongno`   how it is SAID
 *   transliteration (spelling) 종로 -> `Jongro`   how it is WRITTEN, reversible
 *
 * `p` holds the sound form, which is what a dictionary prints and what every one of
 * the standard's examples uses. `pr` holds the spelling form and is written ONLY
 * where the two differ, which is 1,206 of 7,738 words, so a viewer that wants the
 * other form reads `pr ?? p` with no second lookup and no second copy of the string.
 *
 * @param {string} word
 * @param {string} meaning
 * @param {string} pos
 * @param {string} respelling  The source's Hangul pronunciation, kept in `s`.
 * @returns {{p: string, s: string, m: string, t: string, pos: string, pr?: string}}
 */
function newKoreanEntry(word, meaning, pos, respelling) {
  const sound = romanize(word);
  const spelling = romanize(word, { usePronunciationRules: false });
  return {
    p: sound,
    // The source's own Hangul respelling. Not drawn as a reading; kept because it
    // is the source's data and dropping it would discard information for free.
    s: respelling,
    m: meaning,
    // Unused, as for Japanese. Korean has no second script for a word.
    t: '',
    pos,
    ...(spelling !== sound ? { pr: spelling } : {}),
  };
}

/**
 * Korean: NIKL levels and Yonsei course levels, with definitions from Yonsei.
 *
 * TWO sources, two lists, and they are complementary rather than redundant.
 * Measured over their union (7,738 words): NIKL contributes 1,019 words no other
 * list places and Yonsei 1,913, while the two overlap by only about 25%. Yonsei is
 * every word of a six-volume course; NIKL is a graded lemma list.
 *
 * TOPIK is NOT used, and that is a licence decision rather than a data one. TOPIK's
 * own terms of use (Article 15) assign copyright in all site content to TOPIK,
 * make unauthorised reproduction or distribution punishable, and require permission
 * to use the content for profit "or a corresponding benefit". Its operator NIIED
 * limits free use to personal, academic and research purposes. NIKL, by contrast,
 * publishes under KOGL Type 1, which permits derivatives and commercial use with
 * attribution. Shipping TOPIK would be shipping data whose owner asks for exactly
 * what this would do. The `topik_level` column in the source is therefore ignored.
 *
 * THE JOIN. Only words present in the level list AND the definition list have a
 * definition, but that is now a much smaller gap than it was, because Yonsei is
 * itself a list and every word it contributes has a gloss by construction. A word
 * known only to NIKL still ships, with an empty `m`. This is load-bearing:
 * `indexDictionary()` builds `headwords` from the keys of `words`, so a word in
 * `levels` but absent from `words` can never be marked at all and would silently
 * vanish from a Korean video. Emitting the entry keeps every levelled word
 * markable, and the popover already renders "No definition for this word yet." for
 * an empty `m` (marks.js), so the limit is visible rather than hidden.
 *
 * @param {string} sourcePath
 * @param {string} yonseiDirPath
 * @returns {Promise<object[]>}
 */
async function buildKorean(sourcePath, yonseiDirPath) {
  const tsv = await readFile(sourcePath, 'utf8');
  const yonsei = await readYonsei(yonseiDirPath);

  /** @type {Record<string, Record<string, number>>} */
  const levels = { nikl: {}, yonsei: {} };

  /** @type {Record<string, {p: string, m: string, t: string, pos: string}>} */
  const words = {};

  const dropped = { noWord: 0, noLevel: 0 };
  let suffixed = 0;
  let mergedSenses = 0;

  // --- The level list: NIKL grades, and the words it holds -------------------

  const lines = tsv.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Drop the header, and any trailing blank the file may end with.
    if (i === 0 || !lines[i].trim()) continue;

    const [, rawWord, partOfSpeech, , , nikl] = splitTsv(lines[i]);

    if (!rawWord) {
      dropped.noWord++;
      continue;
    }
    if (/\d{1,2}$/.test(rawWord)) suffixed++;
    const word = stripHomographSuffix(rawWord);

    const grade = niklLevel(nikl);
    // A row with no NIKL level contributes a word with no level and no reliable
    // definition, since this source has no usable gloss. Skipped rather than
    // emitted, unless the definition source knows the word (below).
    if (grade === null) {
      dropped.noLevel++;
      continue;
    }

    // EASIEST WINS across merged homograph senses, so a word is never placed higher
    // than any list says it is. The senses are one entry in our model, and taking
    // the harder of two would overstate what the learner needs.
    const existing = levels.nikl[word];
    if (existing === undefined) levels.nikl[word] = grade;
    else if (grade < existing) levels.nikl[word] = grade;
    else mergedSenses++;

    if (!(word in words)) {
      // `explanation` is a collocation hint rather than a definition (`~에 가다`
      // for 가게, "to go to a shop") and is empty on 18% of rows. It is Korean
      // guidance for a Korean learner, so used as the meaning it would read as a
      // non-answer next to a real gloss, and it is not used. The meaning comes
      // from the definition source, where there is one.
      const d = yonsei.get(word);
      words[word] = newKoreanEntry(word, d?.m ?? '', partOfSpeech || d?.pos || '', d?.p ?? '');
    }
  }

  // --- The course source: a level for every word, and the definitions --------

  for (const [word, d] of yonsei) {
    levels.yonsei[word] = d.level;
    if (word in words) {
      // Already present from the level list, which may have had no definition for
      // it. Fill the gap rather than replacing the entry, so the part of speech
      // from the level list is kept when it exists.
      if (!words[word].m) words[word].m = d.m;
      if (!words[word].s) words[word].s = d.p;
      if (!words[word].pos) words[word].pos = d.pos;
      continue;
    }
    // A course word the graded list does not place. It ships with a definition and
    // a course level, which is the whole point of adding this source.
    words[word] = newKoreanEntry(word, d.m, d.pos, d.p);
  }

  const total = Object.keys(words).length;
  const withDefinition = Object.keys(words).filter((w) => words[w].m !== '').length;

  const payload = {
    meta: buildMeta({
      sources: [
        {
          name: 'NIKL 한국어 학습용 어휘 목록 (National Institute of Korean Language), via julienshim/combined_korean_vocabulary_list',
          licence: 'KOGL Type 1',
          url: 'https://github.com/julienshim/combined_korean_vocabulary_list',
          sha256: 'bb5789e46d818842ed6cc15c7946805ad1aed9fd1d0912d884cc48a8556b9a3c',
          note: 'results.tsv, `nikl_level` column only. The aggregator is MIT for its code and states it does not host the source lists; the data is NIKL\'s, published under KOGL Type 1 (공공누리 제1유형), which permits derivatives and commercial use with attribution. The `topik_level` column is NOT used: TOPIK\'s own terms reserve those rights. The `explanation` column is a collocation hint, not a gloss, and is unused.',
        },
        {
          name: 'Open Yonsei Korean Vocabulary (Amulopapa67), a community companion to the six-volume Yonsei course, not affiliated with Yonsei University',
          licence: 'CC BY-SA 3.0',
          url: 'https://github.com/Amulopapa67/open-yonsei-korean-vocabulary',
          tag: 'v0.1.0',
          note: 'vol-01.json … vol-06.json. Definitions, text readings, and the course level (the first volume a word appears in). The project licenses its data CC BY-SA 3.0 and excludes textbook lessons, examples, audio and official artwork.',
        },
      ],
      wordCount: total,
      compiledBy: 'National Institute of Korean Language (levels); Open Yonsei Korean Vocabulary (definitions, readings, course levels)',
      note: 'Two lists. NIKL grades words A to C; Yonsei places them by the volume of the course that introduces them. Where a word has no definition the popover says so, and the word still marks. Homograph senses (가구03, 가구04) merge into one entry at the easiest grade.',
    }),
    lists: KOREAN_LISTS.map((list) => listMeta(list, levels[list.id])),
    levels,
    words,
  };

  await writeFile(KOREAN_OUT, JSON.stringify(payload), 'utf8');

  console.log(`wrote ${KOREAN_OUT}`);
  console.log(`  words: ${total}`);
  console.log(`  with a definition: ${withDefinition} (${Math.round((withDefinition / total) * 100)}%)`);
  console.log(`  markable with no definition: ${total - withDefinition}`);
  console.log(`  homograph-suffixed rows: ${suffixed}`);
  console.log(`  merged senses (easiest kept): ${mergedSenses}`);
  console.log(`  dropped (no word): ${dropped.noWord}`);
  console.log(`  dropped (no NIKL level, not in the course): ${dropped.noLevel}`);
  console.log(`  nikl levelled: ${Object.keys(levels.nikl).length}`);
  console.log(`  yonsei levelled: ${Object.keys(levels.yonsei).length}`);

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
      // NO `generatedAt`. There was one, and it was the only reason this file
      // could not reproduce: a timestamp changes on every run, so a byte
      // comparison against the committed copy always failed and `check-wordlists`
      // could not exist. Nothing read it, and a build date is not provenance.
      // The source revisions are pinned in each dictionary's `meta.sources`,
      // which is where a reader should look for when this data came from.
      note: 'Generated by tools/build-wordlist.mjs. Maps lists to the dictionary holding their words.',
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

// Created up front so `--out` can point at a directory that does not exist yet,
// which is how the verification script gets a clean scratch space.
await mkdir(OUT_DIR, { recursive: true });

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
