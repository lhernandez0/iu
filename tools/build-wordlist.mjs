/**
 * Build the bundled word list from the CC-CEDICT-derived source.
 *
 * Run manually when the data changes; the output is committed. This is not part
 * of the extension and is never loaded by it.
 *
 *   node tools/build-wordlist.mjs path/to/parsed_hsk_enriched.json
 *
 * Source: https://github.com/TeaPearce/chinese-english-dictionary
 *   data/parsed_hsk_enriched.json — 11,470 usable entries, CC BY-SA 4.0,
 *   derived from CC-CEDICT, with HSK levels overridden from the official HSK 3.0
 *   word list (upstream file data/hsk31-words-pleco.txt; "Pleco" in that
 *   filename is the OCR tool, not the author — the list is the MOE-published
 *   standard, extracted from the official PDF and OCR'd with Pleco OCR).
 *
 * PINNED SOURCE — this is what makes the build reproducible (see the licence
 * audit, finding A4). The input is not committed and is not fetched by this
 * script, so the only way to rebuild a checkout is to take the exact revision:
 *
 *   commit  a9aea223269eb9820590e5bca783eb299c317439  (2026-08-27)
 *   blob    7562130dea9284b99c86c9e8a5b8fe0a2cc003a1
 *   sha256  e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10
 *   url     https://raw.githubusercontent.com/TeaPearce/chinese-english-dictionary/\
 *             a9aea223269eb9820590e5bca783eb299c317439/data/parsed_hsk_enriched.json
 *
 * Verified 2026-10-06: rebuilding from that revision reproduces the committed
 * `chinese.json` exactly — same 11,470 words, identical levels, zero differing
 * entries. The blob hash is recorded as well as the commit because a commit can
 * be rewritten while a blob hash cannot; if the two ever disagree, trust the
 * blob than the URL.
 *
 * What it emits, and why in this shape:
 *
 *   - THREE keyed objects rather than one array of records. `levels` holds only
 *     the numbers per list, so a word with no level is simply absent from it.
 *     That is what makes "definition yes, colour no" fall out for free instead
 *     of needing a null-level branch.
 *   - Both HSK numberings, kept separate and selectable. They are alternative
 *     numberings of the same vocabulary, not a merged truth.
 *   - Nothing in this file knows or cares what HSK is. A list has an id and a
 *     level count; that is the whole contract, so JLPT slots in unchanged.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(here, '../src/learn/data/chinese.json');

const [, , sourcePath] = process.argv;
if (!sourcePath) {
  console.error('usage: node tools/build-wordlist.mjs <parsed_hsk_enriched.json>');
  process.exit(1);
}

const source = JSON.parse(await readFile(sourcePath, 'utf8'));

/**
 * The word lists a learner can choose between.
 *
 * `levelCount` is what the colour ramp divides by, so it has to be the real
 * count for the list rather than the highest level present.
 *
 * `defaultThreshold` is the level marking STARTS at for this list, and it lives
 * here rather than being hand-edited into the JSON. It was hand-added once, and
 * the consequence was not obvious until this file was re-run: the rebuild
 * silently dropped it, the worker's `defaultThreshold()` fell back to 1, and the
 * starting level moved without anything saying so. A field the artefact carries
 * must be a field this script emits, or the artefact is not reproducible — which
 * is the whole point of pinning the input.
 *
 * It is per list, not global, because a threshold is relative: 4 means "upper
 * intermediate" in a 6-level list and something else in a 9-level one, so a
 * JLPT list would carry its own value (or none, and fall back to 1).
 */
const LISTS = [
  { id: 'hsk2_0', label: 'HSK 2.0', levelCount: 6, defaultThreshold: 4, field: 'hsk2_0' },
  { id: 'hsk3_0', label: 'HSK 3.0', levelCount: 9, defaultThreshold: 4, field: 'hsk3_0' },
];

/** @type {Record<string, Record<string, string>>} */
const levels = {};
for (const list of LISTS) levels[list.id] = {};

/** @type {Record<string, {p: string, m: string, t: string, pos: string}>} */
const words = {};

let dropped = { noSimplified: 0, noMeaning: 0 };

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

  for (const list of LISTS) {
    const level = entry[list.field];
    // Absent rather than null. This is the "colour no" case.
    if (typeof level === 'number') levels[list.id][word] = level;
  }
}

const payload = {
  // Provenance travels with the data so the licence is discoverable from the
  // artefact itself, not only from this script. Generated here rather than
  // hand-written into the JSON, because a hand-edited note and a script that
  // does not know about it drift apart the moment either one changes — which is
  // exactly what happened once already.
  meta: {
    source: 'CC-CEDICT via TeaPearce/chinese-english-dictionary',
    compiledBy: 'Tim Pearce (TeaPearce/chinese-english-dictionary)',
    licence: 'CC BY-SA 4.0',
    sourceCommit: 'a9aea223269eb9820590e5bca783eb299c317439',
    sourceSha256: 'e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10',
    note: 'HSK levels from the official MOE HSK 3.0 word list (via TeaPearce data/hsk31-words-pleco.txt; "Pleco" there is the OCR tool, not the author). Unlevelled words have a definition but no level.',
    wordCount: Object.keys(words).length,
  },
  lists: LISTS.map(({ id, label, levelCount, defaultThreshold }) => ({
    id,
    label,
    language: 'zh',
    levelCount,
    levelled: Object.keys(levels[id]).length,
    defaultThreshold,
  })),
  levels,
  words,
};

await writeFile(OUTPUT, JSON.stringify(payload), 'utf8');

const stats = {
  'words with a definition': Object.keys(words).length,
  'dropped: no simplified': dropped.noSimplified,
  'dropped: no meaning': dropped.noMeaning,
};
for (const list of LISTS) stats[`${list.id} levelled`] = Object.keys(levels[list.id]).length;

console.log(`wrote ${OUTPUT}`);
for (const [key, value] of Object.entries(stats)) console.log(`  ${key}: ${value}`);
