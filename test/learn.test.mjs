/**
 * Unit tests for the learning layer: segmentation and the colour ramp.
 *
 * The segmentation numbers were measured in Python while deciding whether Jieba
 * was needed. Porting the algorithm to JavaScript without re-measuring would be
 * trusting the port, so the measurement is repeated here against the real data.
 *
 * Run with `npm test`.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segment, segmentSegments } from '../src/learn/segment.js';
import { levelColour, DEFAULT_PALETTE } from '../src/learn/wordlist.js';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;

/**
 * @param {string} name
 * @param {any} actual
 * @param {any} expected
 */
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

// The bundled data, as the extension ships it.
const bundle = JSON.parse(await readFile(resolve(here, '../src/learn/data/chinese.json'), 'utf8'));
const HEADWORDS = new Set(Object.keys(bundle.words));
const MAX_LEN = Math.max(...[...HEADWORDS].map((w) => w.length));

// --- Segmentation: invariants ------------------------------------------------

section('segmentation never changes the text');

{
  // The strongest available invariant: joining every token must reproduce the
  // input exactly. It catches off-by-one errors in the index arithmetic, which
  // are otherwise invisible until a character goes missing on screen.
  const samples = [
    '我们在岸上等你',
    '他挨着我坐',
    'Hello 世界，这是一个 test 123。',
    '研究生命起源',
    '',
    '。',
    'abc',
    '囍嚻',
  ];

  for (const text of samples) {
    const tokens = segment(text, HEADWORDS, MAX_LEN);
    check(`round-trips ${JSON.stringify(text)}`, tokens.map((t) => t.text).join(''), text);
  }
}

section('segmentation indices are contiguous and exact');

{
  const text = '我们在岸上等你！';
  const tokens = segment(text, HEADWORDS, MAX_LEN);
  const contiguous = tokens.every((t, i) => (i === 0 ? t.start === 0 : t.start === tokens[i - 1].end));
  check('every token starts where the last ended', contiguous, true);
  check('the last token ends at the end', tokens.at(-1).end, text.length);
}

section('non-Chinese passes through untouched');

{
  // All non-Chinese, so it is one contiguous run and stays a single token. A
  // span containing spaces still wraps normally, so splitting latin words apart
  // would buy nothing.
  const tokens = segment('Hello，world 123', HEADWORDS, MAX_LEN);
  check('one run for a wholly non-Chinese line', tokens.length, 1);
  check('the run is the whole line', tokens[0].text, 'Hello，world 123');
  check('it is not marked known', tokens[0].known, false);
  check('it round-trips', tokens.map((t) => t.text).join(''), 'Hello，world 123');
}

{
  // Mixed content is where the run detection matters: the Chinese is segmented
  // and the rest is left alone.
  const tokens = segment('Hello 世界 world', HEADWORDS, MAX_LEN);
  check('three tokens', tokens.length, 3);
  check('the Chinese word is recognised', tokens[1].known, true);
  check('and is a real headword', tokens[1].text, '世界');
}

// --- Segmentation: the behaviour that matters --------------------------------

section('longest match prefers the compound, which is the point');

{
  // The characteristic case: the list holds both 岸 and 岸上, and 岸上 is the
  // better token. This is what made the measured accuracy a floor rather than a
  // ceiling — a naive test looking for 岸 counts this as a failure.
  const tokens = segment('我们在岸上等你', HEADWORDS, MAX_LEN);
  const texts = tokens.map((t) => t.text);
  check('岸上 is kept whole', texts.includes('岸上'), true);
  check('and the bare 岸 is not produced', texts.includes('岸'), false);
}

{
  const texts = segment('我们下个月要搬家', HEADWORDS, MAX_LEN).map((t) => t.text);
  check('搬家 is kept whole', texts.includes('搬家'), true);
}

{
  const texts = segment('发现钱包丢了就赶紧报警', HEADWORDS, MAX_LEN).map((t) => t.text);
  check('报警 is kept whole', texts.includes('报警'), true);
}

section('a character absent from the dictionary is still tokenised');

{
  const tokens = segment('囍嚻', HEADWORDS, MAX_LEN);
  check('two tokens', tokens.length, 2);
  check('neither is known', tokens.every((t) => !t.known), true);
  check('text preserved', tokens.map((t) => t.text).join(''), '囍嚻');
}

// --- Segmentation: the invariant callers depend on ---------------------------

section('every multi-character Chinese token is a known word');

{
  // This is the property the renderer relies on: a Chinese token is either a
  // headword we can look up, or a single character we fall back on. Anything
  // else would be a multi-character run we could neither define nor classify.
  //
  // Note the accuracy figure quoted in the docs — 97.9% of target words kept
  // intact — was measured against the source corpus of example sentences, which
  // is deliberately NOT bundled (it would have more than doubled the payload for
  // data this layer does not use). That corpus is not available here, so this
  // checks the invariant instead of re-deriving accuracy it cannot measure.
  const chinese = /[\u4e00-\u9fff]/;
  const sample = [
    '我们在岸上等你',
    '他挨着我坐然后我们下个月要搬家',
    '发现钱包丢了就赶紧报警',
    '研究生命起源',
    '这本书的内容很有意思但是有点难',
    '我不知道他为什么没有来',
  ];

  const tokens = sample.flatMap((line) => segment(line, HEADWORDS, MAX_LEN));
  const suspicious = tokens.filter((t) => t.text.length > 1 && chinese.test(t.text) && !t.known);

  check('no multi-character Chinese token is unrecognised', suspicious.length, 0);
  check('and the sample produced tokens', tokens.length > 20, true);
  console.log(
    `        (${tokens.length} tokens, ${tokens.filter((t) => t.known).length} known words)`,
  );
}

section('real speech containing words outside the list still round-trips');

{
  // Names and coinages are the realistic unknown: they should survive as
  // characters rather than being mangled or dropped.
  const text = '张伟说他喜欢喝珍珠奶茶';
  const tokens = segment(text, HEADWORDS, MAX_LEN);
  check('text preserved', tokens.map((t) => t.text).join(''), text);
  check('every token is a word or a single character',
    tokens.every((t) => t.known || t.text.length === 1), true);
}

section('a whole transcript segments per line, keeping cues separate');

{
  // This is the function the worker calls. Segmenting each line on its own is
  // what stops a word spanning two cues — which would attach it to the wrong
  // timestamp, and is the reason the obvious "join everything" is wrong.
  const segments = [
    { start: 0, duration: 2, text: '我们在岸上等你' },
    { start: 2, duration: 2, text: 'Hello world' },
    { start: 4, duration: 2, text: '然后我们下个月要搬家' },
  ];

  const lines = segmentSegments(segments, HEADWORDS, MAX_LEN);

  check('one token list per segment', lines.length, segments.length);
  check('order is preserved', lines[0].map((t) => t.text).join(''), segments[0].text);
  check('the middle line is untouched', lines[1].map((t) => t.text).join(''), 'Hello world');
  check('the last line round-trips', lines[2].map((t) => t.text).join(''), segments[2].text);

  // A word must not straddle a boundary. 后…们 across lines 0/2 would be the
  // symptom, so no token may contain text from two segments.
  const straddling = lines.flat().filter((t) => t.text.includes('们下'));
  check('no token spans two cues', straddling.length, 0);

  check('a missing text field is tolerated', segmentSegments([{ start: 0 }], HEADWORDS, MAX_LEN)[0].length, 0);
}

section('speed is not a concern');

{
  const text = '我们在岸上等你的这段时间里他一直挨着我坐然后我们下个月要搬家';
  const big = text.repeat(1000); // ~32k characters, far longer than any transcript

  const started = Date.now();
  segment(big, HEADWORDS, MAX_LEN);
  const ms = Date.now() - started;

  console.log(`        ${big.length} chars in ${ms} ms`);
  // Generous bound: a real transcript is ~5k characters, so this allows a
  // hundredfold regression before it would matter to a user.
  check('a very long line segments in well under a second', ms < 1000, true);
}

// --- Colour ramp -------------------------------------------------------------

section('the colour ramp maps level to a position, and cannot wrap');

{
  check('a single-level list returns the first stop', levelColour(1, 1), DEFAULT_PALETTE[0]);
  check('the lowest level is the first stop', levelColour(1, 5), 'rgb(79, 157, 105)');
  check('the highest level is the last stop', levelColour(5, 5), 'rgb(201, 79, 79)');
}

{
  // The problem the ramp exists to solve: eight levels must all differ, where a
  // hue rotation would begin repeating.
  const colours = new Set();
  for (let level = 1; level <= 8; level++) colours.add(levelColour(level, 8));
  check('eight levels produce eight distinct colours', colours.size, 8);
}

{
  const forty = new Set();
  for (let level = 1; level <= 40; level++) forty.add(levelColour(level, 40));
  // A 40-level list is a ramp, not a palette: adjacent levels may blend, but the
  // ends must stay far apart and no two levels may be identical.
  check('a 40-level list still gives 40 values', forty.size, 40);
  console.log(`        (40 distinct values across ${forty.size} levels — a ramp, not a palette)`);
}

{
  // Out-of-range levels must clamp rather than extrapolate to a colour that is
  // not in the palette, which is what a naive interpolation would do.
  check('level 0 clamps to the first stop', levelColour(0, 5), levelColour(1, 5));
  check('level 99 clamps to the last stop', levelColour(99, 5), levelColour(5, 5));
  check('a non-numeric level falls back to the first stop', levelColour(NaN, 5), DEFAULT_PALETTE[0]);
}

{
  const six = [];
  for (let level = 1; level <= 6; level++) six.push(levelColour(level, 6));
  const distinct = new Set(six).size;
  console.log(`        HSK 2.0 (6 levels): ${distinct} distinct colours`);
  check('all six HSK levels are visually distinct', distinct, 6);
}

// --- The learning layer is a leaf -------------------------------------------

section('the learning layer does not depend on the browser');

{
  // `learn/` is the part that would be reused for another language, and the whole
  // point of the layering is that it is pure data and logic. It used to call
  // `chrome.runtime.getURL` itself, which made it unusable outside an extension
  // and untestable without a `chrome` stub — so this guards the property rather
  // than trusting it, because reaching for a convenience is easy and invisible.
  //
  // Read as text rather than imported: an import would only prove that THIS
  // process could evaluate it, and Node has no `chrome` either way. The rule is
  // about the source.
  for (const file of ['segment.js', 'wordlist.js']) {
    const source = await readFile(resolve(here, '../src/learn', file), 'utf8');
    // Comments are stripped first, or the many comments explaining WHY chrome is
    // absent would fail the check for saying the word.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(`${file} does not reach for chrome`, /chrome\s*\./.test(code), false);
    check(`${file} imports nothing`, /^\s*import\s/m.test(code), false);
  }
}

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
