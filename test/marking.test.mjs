/**
 * The shared marking module, and the list/language matching the reader relies on.
 *
 * Pure functions over a dictionary, so they run hermetically. That matters here
 * because this module is what the PANEL and the READER both render from — if the
 * language matching is wrong, the reader silently marks nothing (Japanese captions
 * against a Chinese list), which looks like a broken feature rather than a wrong
 * list.
 *
 * Run: node test/marking.test.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexDictionary } from '../src/learn/wordlist.js';
import { markLine, listCoversLanguage, listForLanguage } from '../src/learn/marking.js';
import { segment } from '../src/learn/segment.js';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;

/** @param {string} name @param {any} actual @param {any} expected */
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  pass  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`);
    failures++;
  }
}

/** @param {string} name */
function section(name) {
  console.log(`\n${name}`);
}

const index = JSON.parse(await readFile(resolve(here, '../src/learn/data/index.json'), 'utf8'));
const chinese = indexDictionary(
  JSON.parse(await readFile(resolve(here, '../src/learn/data/chinese.json'), 'utf8')),
);

section('a list covers a language, and the script subtag does not confuse it');

{
  const hsk = index.lists.find((list) => list.id === 'hsk3_0');
  const jlpt = index.lists.find((list) => list.id === 'jlpt');

  check('HSK covers Chinese', listCoversLanguage(hsk, 'zh'), true);
  check('and Chinese Simplified', listCoversLanguage(hsk, 'zh-Hans'), true);
  check('and Chinese Traditional', listCoversLanguage(hsk, 'zh-Hant'), true);
  check('but NOT Japanese', listCoversLanguage(hsk, 'ja'), false);

  check('JLPT covers Japanese', listCoversLanguage(jlpt, 'ja'), true);
  check('but NOT Chinese', listCoversLanguage(jlpt, 'zh'), false);

  // An untagged track has no language, and marking it would be a guess.
  check('an unknown (und) language is not covered', listCoversLanguage(hsk, 'und'), false);
  check('and null is not either', listCoversLanguage(hsk, null), false);
}

section('the list is chosen to match the track');

{
  // **This is the reader's bug, as a test.** It grades against one list and has no
  // picker, so if the choice is not driven by the track's language the captions for
  // a Japanese film are marked against HSK, find nothing, and render plain — which
  // reads as "the captions feature is broken" rather than "the wrong list was used".
  check('Japanese picks JLPT', listForLanguage(index.lists, 'ja')?.id, 'jlpt');
  check('Chinese picks an HSK list', listForLanguage(index.lists, 'zh')?.language, 'zh');
  // The index lists the broadest first, so the choice is the one that places the most
  // words — HSK 3.0 at 10,969 against HSK 2.0 at 4,993.
  check('and it is HSK 3.0, the broader list', listForLanguage(index.lists, 'zh')?.id, 'hsk3_0');
  // An unknown language still gets a list rather than nothing, so a film with an
  // untagged track is not left entirely unmarked.
  check('an unknown language still gets a list', Boolean(listForLanguage(index.lists, 'und')), true);
  check('and no lists at all is null', listForLanguage([], 'zh'), null);
}

section('marking a Chinese line');

{
  const list = index.lists.find((entry) => entry.id === 'hsk3_0');
  const tokens = segment('你好世界', chinese.headwords, chinese.maxWordLength);
  const marked = markLine(tokens, chinese, list, 1, true);

  check('every token came back', marked.length, tokens.length);
  check('the text is preserved', marked.map((t) => t.text).join(''), '你好世界');
  // 你 is in the dictionary, so it is definable — the distinction that made whole
  // sentences look unmarked when it was conflated with having a level.
  check('a known word is definable', marked.some((token) => token.defined), true);
  check('and carries a reading when one is asked for', marked.some((token) => Boolean(token.reading)), true);

  // With readings off the annotations are absent, not empty — the payload is
  // byte-identical to before readings existed, so nobody pays for what they do not
  // show.
  const plain = markLine(tokens, chinese, list, 1, false);
  check('no reading fields when readings are off', plain.every((token) => token.reading === undefined), true);
}

section('marking does not depend on the surface');

{
  // The point of extracting this: the worker and the reader call the same function,
  // so the same token cannot come out differently. A property rather than a value —
  // it holds for any input, which is what makes it worth asserting.
  const list = index.lists.find((entry) => entry.id === 'hsk3_0');
  const tokens = segment('大家好', chinese.headwords, chinese.maxWordLength);
  const first = markLine(tokens, chinese, list, 3, true);
  const second = markLine(tokens, chinese, list, 3, true);
  check('the same input gives the same output', JSON.stringify(first), JSON.stringify(second));

  // A list that cannot grade the text returns everything undefined rather than
  // throwing — the reader relies on that when it loads a dictionary before a track.
  const foreign = markLine(tokens, chinese, index.lists.find((l) => l.id === 'jlpt'), 1, true);
  check('no tokens are marked against a foreign list', foreign.filter((t) => t.level !== null).length, 0);
  check('but they are still definable', foreign.some((t) => t.defined), true);
}

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
