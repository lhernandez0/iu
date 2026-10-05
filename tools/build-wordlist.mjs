/**
 * Build the bundled word list from the CC-CEDICT-derived source.
 *
 * Run manually when the data changes; the output is committed. This is not part
 * of the extension and is never loaded by it.
 *
 *   node tools/build-wordlist.mjs path/to/parsed_hsk_enriched.json
 *
 * Source: https://github.com/TeaPearce/chinese-english-dictionary
 *   data/parsed_hsk_enriched.json — 11,494 entries, CC BY-SA 4.0, derived from
 *   CC-CEDICT, with HSK levels overridden from Pleco's HSK 3.1 list.
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
 */
const LISTS = [
  { id: 'hsk2_0', label: 'HSK 2.0', levelCount: 6, field: 'hsk2_0' },
  { id: 'hsk3_0', label: 'HSK 3.0', levelCount: 9, field: 'hsk3_0' },
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
  // artefact itself, not only from this script.
  meta: {
    source: 'CC-CEDICT via TeaPearce/chinese-english-dictionary',
    licence: 'CC BY-SA 4.0',
    note: 'HSK levels overridden from Pleco HSK 3.1. Unlevelled words have a definition but no level.',
    wordCount: Object.keys(words).length,
  },
  lists: LISTS.map(({ id, label, levelCount }) => ({
    id,
    label,
    language: 'zh',
    levelCount,
    levelled: Object.keys(levels[id]).length,
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
