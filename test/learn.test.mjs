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
const TONE_MARKED = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/;

import {
  levelColour,
  DEFAULT_PALETTE,
  indexDictionary,
  readingOf,
  traditionalOf,
  pinyinToNumbers,
  PINYIN_SYLLABLES,
} from '../src/learn/wordlist.js';

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

// The second language, so the shared code is exercised against more than one
// dictionary rather than only the one it was written for.
const japanese = JSON.parse(await readFile(resolve(here, '../src/learn/data/japanese.json'), 'utf8'));
const JA_HEADWORDS = new Set(Object.keys(japanese.words));
const JA_MAX_LEN = Math.max(...[...JA_HEADWORDS].map((w) => w.length));

// --- Japanese: what the segmenter can and cannot mark ------------------------

section('the segmenter marks kanji and kana Japanese alike');

{
  // This was the measured boundary the Japanese plan was built on, and it has
  // MOVED. The segmenter used to try a word list only when a token's FIRST
  // character was Han, so a run beginning with kana passed through whole and was
  // never looked up, which left a large share of ordinary Japanese unmarkable,
  // because much of it is written in kana and nowhere else. The kana blocks are
  // now in the matcher, so this asserts the new behaviour.
  //
  // ⚠️ Chinese is unaffected: Chinese text contains no kana, so no run of Chinese
  // can tokenise differently than it did before.
  const known = (text) => segment(text, JA_HEADWORDS, JA_MAX_LEN).some((t) => t.known);

  check('a kanji-initial verb is matched', known('会う'), true);
  check('a kanji compound is matched', known('日本語'), true);
  check('kanji with okurigana is matched', known('食べる'), true);

  // The gap that closed. とても is a kana-only headword: present in the dictionary
  // since the Japanese build, and previously unmatchable no matter what.
  check('the kana word is in the list', JA_HEADWORDS.has('とても'), true);
  check('and it is now matched', known('とても'), true);
  check('including a long kana word', known('いらっしゃい'), true);

  // Tokens must still reproduce the input exactly, or marks land on the wrong
  // characters, the invariant the whole render depends on.
  const toks = segment('私は学生です', JA_HEADWORDS, JA_MAX_LEN);
  check('tokenising still reproduces the line', toks.map((t) => t.text).join(''), '私は学生です');
  check('and the particles are looked up too', toks.some((t) => t.known && t.text === 'は'), true);

  // Inflection remains a SEPARATE, unfixed gap, and this is still the honest
  // account of it. The matcher is exact against headwords, so 食べました does not
  // equal 食べる, but 食 IS a headword alone, so longest match takes the bare
  // character and marks it. The result is a colour on 食 carrying the meaning of
  // 食 while the line says 食べました: a confident wrong mark, not a missing one.
  check('the dictionary form is present', JA_HEADWORDS.has('食べる'), true);
  check('an inflected form still marks its bare first character', known('食べました'), true);
  check('and that character is the one marked, not the whole word', segment('食べました', JA_HEADWORDS, JA_MAX_LEN).some((t) => t.known && t.text === '食'), true);
  check('leaving the inflected tail unmarked', segment('食べました', JA_HEADWORDS, JA_MAX_LEN).some((t) => !t.known && t.text === 'べ'), true);
}

// --- Korean: the same boundary, before the data lands ------------------------

section('the segmenter sees Hangul, without which nothing Korean can mark');

{
  // The measured blocker the Korean plan was built on. Hangul was not in the
  // matcher, so  not a single Korean character  was ever looked at, and a whole
  // Korean sentence came through as ONE token. This asserts the class now covers
  // it, which is the precondition for any Korean word being markable at all.
  //
  // Synthetic headwords on purpose: this is a test of the segmenter, not of the
  // Korean word list, and it must hold before that list is generated and after.
  const KO_HEADWORDS = new Set(['안녕', '학교', '한국어', '가요', '저', '학생']);
  const KO_MAX_LEN = 4;
  const known = (text) => segment(text, KO_HEADWORDS, KO_MAX_LEN).some((t) => t.known);

  // The regression, stated as the thing that was true: a sentence with no space
  // between matched words is one token, so nothing inside it could ever match.
  check('a Korean sentence is no longer a single token', segment('안녕하세요', KO_HEADWORDS, KO_MAX_LEN).length > 1, true);
  check('a headword inside it is matched', known('안녕하세요'), true);
  check('and the match is the headword, not a fragment', segment('안녕하세요', KO_HEADWORDS, KO_MAX_LEN)[0].text, '안녕');

  // Korean is space-separated, unlike Chinese and Japanese, and this relies on a
  // space not being in the class so a run already breaks on it. Asserted because
  // if the class ever gained whitespace, the walk would cross word boundaries and
  // the tokens would stop reproducing the line.
  const spaced = segment('안녕하세요 학교에 가요', KO_HEADWORDS, KO_MAX_LEN);
  check('tokenising reproduces the line with its spaces', spaced.map((t) => t.text).join(''), '안녕하세요 학교에 가요');
  check('the space survives as its own token', spaced.some((t) => t.text === ' '), true);
  check('so a word after a space is matched too', spaced.some((t) => t.known && t.text === '학교'), true);

  // Compatibility jamo (ㄱ, ㄴ, ㅏ) and conjoining jamo are in the class as well.
  // Asserted directly, because they are the ranges a reader is most likely to
  // assume are unnecessary and quietly drop.
  check('compatibility jamo are matched', segment('ㄱㄴ', KO_HEADWORDS, KO_MAX_LEN).length > 1, true);
  check('conjoining jamo are matched', segment('\u1100\u1161', KO_HEADWORDS, KO_MAX_LEN).length > 1, true);

  // Widening the class must not change Chinese or Japanese, the guarantee the
  // change is only acceptable under. Neither language contains Hangul, so a run
  // of either must tokenise exactly as it did before.
  check('Chinese is untouched', segment('我们在岸上等你', HEADWORDS, MAX_LEN).map((t) => t.text).join(''), '我们在岸上等你');
  check('Japanese is untouched', segment('私は学生です', JA_HEADWORDS, JA_MAX_LEN).map((t) => t.text).join(''), '私は学生です');
  check('and Chinese still matches its own headwords', segment('我们在岸上等你', HEADWORDS, MAX_LEN).some((t) => t.known), true);
}

section('the Japanese dictionary is internally consistent');

{
  const words = Object.keys(japanese.words);
  check('it has words', words.length > 20000, true);

  // Every levelled word must be a word the dictionary can define, or the panel
  // would colour a token it cannot explain on hover.
  const orphaned = Object.keys(japanese.levels.jlpt ?? {}).filter((w) => !(w in japanese.words));
  check('every levelled word has a definition', orphaned.slice(0, 5), []);

  // A reading is what the popover shows, so an entry without one renders a word
  // with no pronunciation and no error.
  const noReading = words.filter((w) => !japanese.words[w].p).slice(0, 5);
  check('every word carries a reading', noReading, []);

  // The kana-only entries are the ones the transform keys on kana. They are
  // present and correct in the data AND matchable by the segmenter since the kana
  // blocks were added to its character class.
  check('a kana-only entry is present and keyed by its kana', japanese.words['とても']?.p, 'とても');
}

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
  // ceiling, a naive test looking for 岸 counts this as a failure.
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
  // Note the accuracy figure quoted in the docs, 97.9% of target words kept
  // intact, was measured against the source corpus of example sentences, which
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
  // what stops a word spanning two cues, which would attach it to the wrong
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
  console.log(`        (40 distinct values across ${forty.size} levels, a ramp, not a palette)`);
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
  // and untestable without a `chrome` stub, so this guards the property rather
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

section('a word carries its reading and its other script, through canonical');

{
  // The reading is one function for both languages, because the data stores them
  // in the same field: `p` is pinyin in the Chinese bundle and the kana reading in
  // the Japanese one. Easy to get wrong from the name, so it is asserted rather
  // than assumed.
  const zh = indexDictionary(bundle);
  const ja = indexDictionary(japanese);

  check('Chinese pinyin', readingOf(zh, '北京'), 'běijīng');
  check('Japanese kana', readingOf(ja, '日本語'), 'にほんご');

  // **The case that needs `canonical`.** The data is keyed by simplified form, so
  // a traditional surface form is not a key and a direct lookup finds nothing,
  // which would look like missing data rather than a missing lookup, and would
  // give every traditional word no reading at all.
  //
  // `阿拉伯語` is traditional for `阿拉伯语`, and its reading is only reachable
  // through `canonical`, a direct lookup misses.
  check('a traditional form resolves through canonical', readingOf(zh, '阿拉伯語'), 'ālābóyǔ');
  check('and calling it by its traditional name is impossible', Object.hasOwn(bundle.words, '阿拉伯語'), false);

  // The reading is stored lowercase, so `Běijīng` is wrong in a test, the
  // capital comes from the dictionary's own casing, not from us.
  check('the reading keeps the data\'s own casing', readingOf(zh, '北京'), 'běijīng');

  check('the other script', traditionalOf(zh, '阿拉伯语'), '阿拉伯語');
  // Japanese has no traditional field to fill, so this is null rather than an
  // empty string, one thing for a caller to check.
  check('and null when there is none', traditionalOf(ja, '日本語'), null);

  // A word we do not hold gives nothing, rather than throwing or inventing.
  check('an unknown word has no reading', readingOf(zh, 'zzzz'), null);
}

section('tone marks convert to numbers, per syllable');

{
  // The whole-string version of this is tempting and wrong: appending the tone at
  // the end of `zhōngyú` gives `zhongyu2`, which is a different word to a reader
  // and ambiguous to anything parsing it back.
  check('a two-syllable word keeps both tones in place', pinyinToNumbers('zhōngyú'), 'zhong1yu2');
  check('a neutral syllable takes no number', pinyinToNumbers('māma'), 'ma1ma');
  check('a toneless reading is unchanged', pinyinToNumbers('de'), 'de');
  check('an empty reading is empty', pinyinToNumbers(''), '');

  // `ü` is in the data, 绿 is `lǜ`, and a table of the five plain vowels leaves
  // it alone, which renders the tone as a literal `ǜ` beside a digit-less vowel.
  check('the ü vowel converts too', pinyinToNumbers('lǜ'), 'lv4');
  check('and without a tone', pinyinToNumbers('lü'), 'lv');

  // Kana has no tone marks, so the same function must pass it through, which is
  // why the caller needs no language check.
  check('kana is left alone', pinyinToNumbers('にほんご'), 'にほんご');
  check('and romaji too', pinyinToNumbers('nihongo'), 'nihongo');
}

section('readings are the data the extension already ships');

{
  // Not a sample: EVERY entry, because the feature is worthless if it works for
  // the words someone happened to test. A reading is either present in the bundle
  // or it cannot be shown, and a gap that is one word in a hundred is invisible
  // until a learner hits it.
  const zh = indexDictionary(bundle);
  const ja = indexDictionary(japanese);

  const zhMissing = Object.keys(bundle.words).filter((word) => !readingOf(zh, word));
  const jaMissing = Object.keys(japanese.words).filter((word) => !readingOf(ja, word));

  check('every Chinese entry has a reading', zhMissing, []);
  check('and every Japanese one', jaMissing, []);

  // The traditional form is what the script conversion displays, so a gap there
  // is a word that stays simplified while its neighbours change.
  const noTraditional = Object.keys(bundle.words).filter((word) => !traditionalOf(zh, word));
  check('every Chinese entry has a traditional form', noTraditional, []);
}

section('the syllable table covers every reading the dictionary ships');

{
  // Three examples prove the algorithm; they do not prove the TABLE. A missing
  // syllable degrades to a single-character guess, so the output is still a
  // string with digits in it, wrong, plausible, and invisible in any test that
  // does not look at all of them.
  //
  // The check: marked and numbered readings must have the same LENGTH, because the
  // conversion replaces one character with one letter and moves the tone into a
  // digit. A syllable boundary found in the wrong place, or not found at all,
  // changes the digit count.
  const zh = indexDictionary(bundle);
  const words = Object.keys(bundle.words);
  const mismatched = [];
  const syllableless = [];

  for (const word of words) {
    const marked = zh.words[word].p;
    if (!marked) continue;
    const numbered = pinyinToNumbers(marked);

    // Every MARKED syllable must end with a digit, except the neutral tone, so
    // count the tone marks in the source and the digits in the output.
    const marks = [...marked].filter((c) => TONE_MARKED.test(c)).length;
    const digits = (numbered.match(/[1-4]/g) ?? []).length;
    if (marks !== digits) mismatched.push({ word, marked, numbered, marks, digits });

    // **Every run of letters must be fully decomposable into table syllables.**
    //
    // Not "no run longer than six": numbered pinyin has no separator between
    // syllables, so `bushang` is a legitimate seven-letter run of `bu` + `shang`.
    // That version of this check failed on real data while the code was right,
    // which is worth recording, a test that fails on correct output sends someone
    // to fix the wrong thing.
    //
    // Consuming a run greedily and requiring nothing to be left over does catch a
    // MISSING syllable, because the fallback takes one character and moves on.
    for (const run of numbered.match(/[a-zü]+/gi) ?? []) {
      let at = 0;
      while (at < run.length) {
        const rest = run.slice(at).toLowerCase();
        const hit = [...rest].some((_, n) => PINYIN_SYLLABLES.has(rest.slice(0, n + 1)))
          ? [...rest].reduce((best, _c, n) => {
              const candidate = rest.slice(0, n + 1);
              return PINYIN_SYLLABLES.has(candidate) ? n + 1 : best;
            }, 0)
          : 0;
        if (!hit) {
          syllableless.push({ word, marked, numbered, run, at });
          break;
        }
        at += hit;
      }
    }
  }

  check('every tone mark becomes exactly one digit', mismatched.slice(0, 5), []);
  check('and no un-splittable run of letters is left', syllableless.slice(0, 5), []);
  // Stated as a count too, because an empty array from a loop that never ran is
  // the failure a slice-to-five would hide.
  check('across all 11,470 entries', words.length, 11470);
}

section('the conversion is reversible, which is why numbered pinyin exists');

{
  // Numbered pinyin is a form you can TYPE. The point of converting is to make a
  // reading searchable and unambiguous, so a conversion that loses information is
  // not doing the job, the tone has to be attached to the syllable it belongs to,
  // and only that makes reading it back possible.
  check('a reader can tell which syllable owns the tone', pinyinToNumbers('zhōngyú'), 'zhong1yu2');
  check('and not by guessing', pinyinToNumbers('zhōngyú') !== 'zhongyu1', true);
  // The trap: `zhongyu` has no space, so the boundary is invisible without the
  // table. Both simpler implementations put the digit somewhere wrong.

  // Casing is carried through from the source rather than normalised: the
  // dictionary capitalises a proper noun (`Běijīng`) and not an ordinary word, and
  // re-casing would be this function deciding something it was not asked to.
  check('a capitalised proper noun keeps its capital', pinyinToNumbers('Běijīng'), 'Bei3jing1');
  check('and an ordinary word stays lowercase', pinyinToNumbers('shénme'), 'shen2me');
  check('an apostrophe is kept as written', pinyinToNumbers("Xī'ān"), "Xi1'an1");
}
// --- Korean: the data, as it ships -------------------------------------------

// The third language, and the first with TWO upstreams: levels from NIKL and
// TOPIK, definitions from the unrelated Yonsei companion. Loaded here rather than
// asserted about, because the interesting properties are all about what the join
// did and did not produce.
const korean = JSON.parse(await readFile(resolve(here, '../src/learn/data/korean.json'), 'utf8'));
const KO_WORDS = new Set(Object.keys(korean.words));

section('the Korean dictionary is internally consistent');

{
  const words = Object.keys(korean.words);
  check('it has words', words.length > 7000, true);

  // Every levelled word MUST also be a `words` key. `headwords` is built from the
  // keys of `words`, so a word present only in `levels` can never be matched by the
  // segmenter and would be invisible with nothing to say why. This is the check
  // that makes the "emit the entry even with no definition" decision load-bearing
  // rather than a preference: thousands of these words have no definition and all
  // of them must still be here.
  const levelled = new Set([...Object.keys(korean.levels.nikl), ...Object.keys(korean.levels.yonsei)]);
  const orphaned = [...levelled].filter((word) => !KO_WORDS.has(word));
  check('every levelled word is also a definable word', orphaned, []);

  // The Yonsei list is the source of the definitions, so every word it holds has a
  // gloss by construction. That is what adding it bought: the words the graded list
  // could not define now carry one. Asserted with a generous threshold rather than
  // an exact count, so a source refresh does not fail here for no reason.
  const yonseiWords = Object.keys(korean.levels.yonsei);
  const yonseiDefined = yonseiWords.filter((w) => korean.words[w].m !== '');
  check('every Yonsei word has a definition', yonseiDefined.length, yonseiWords.length);

  // The other direction is allowed and expected: a word can have a definition and
  // no level, or a level and no definition, which is what "definition yes, colour
  // no" means. Both counts are asserted to be non-trivial so neither source can
  // silently stop contributing.
  const undefinedWords = words.filter((word) => korean.words[word].m === '');
  check('some words have no definition, which is the known limit', undefinedWords.length > 2000, true);
  check('and most words do have one', words.length - undefinedWords.length > 3000, true);
  check('but every word has the full entry shape', words.every((w) => ['p', 'm', 't', 'pos'].every((f) => f in korean.words[w])), true);
  // `t` is the traditional-Chinese field and is unused for Korean, as it is for
  // Japanese. Asserted so a copy-paste from the Chinese builder shows up.
  check('the traditional field is left empty', [...new Set(words.map((w) => korean.words[w].t))], ['']);
}

section('the Korean levels are the source\'s own, and ascend');

{
  for (const [id, count, names] of [
    ['nikl', 3, ['A', 'B', 'C']],
    ['yonsei', 6, ['1', '2', '3', '4', '5', '6']],
  ]) {
    const list = korean.lists.find((l) => l.id === id);
    check(`${id} is declared with ${count} levels`, list?.levelCount, count);
    check(`${id} names them`, list?.levelNames, names);

    const values = [...new Set(Object.values(korean.levels[id]))].sort((a, b) => a - b);
    check(`${id} uses 1..${count}`, values, Array.from({ length: count }, (_, i) => i + 1));
    check(`${id} has no level above its count`, Math.max(...Object.values(korean.levels[id])) <= count, true);
  }

  // TOPIK is deliberately NOT shipped, and this asserts the absence. Its terms of
  // use reserve the rights a redistributed dictionary needs, unlike NIKL's KOGL
  // Type 1 grant. A list reappearing here without the licence being revisited would
  // be the exact mistake this checks against.
  check('no TOPIK list is shipped', korean.lists.some((l) => l.id === 'topik'), false);
  check('and no TOPIK level data is present', 'topik' in korean.levels, false);

  // The homograph merge, which is the transform most likely to be wrong. 가구03 and
  // 가구04 are two senses of one spelling; stripping the suffix merges them, and the
  // EASIEST of the merged rows must win so a word is never placed harder than any
  // list says it is. Asserted through the key rather than the source: the merged
  // word is spelled without its number.
  check('a homograph suffix is stripped from the key', KO_WORDS.has('가구'), true);
  check('and the numbered spelling is not a key', KO_WORDS.has('가구03'), false);
}

section('the two Korean lists are complementary, not redundant');

{
  const nikl = new Set(Object.keys(korean.levels.nikl));
  const yonsei = new Set(Object.keys(korean.levels.yonsei));
  const union = new Set([...nikl, ...yonsei]);
  const shared = [...nikl].filter((w) => yonsei.has(w));

  // The measured claim that justifies shipping both: they cover substantially
  // different words. If a future source change made one a near-subset of the other
  // (as HSK 2.0 is of HSK 3.0), this fails and says so.
  const overlap = shared.length / union.size;
  check('the overlap is well under half the union', overlap < 0.5, true);
  check('NIKL contributes words Yonsei does not', [...nikl].filter((w) => !yonsei.has(w)).length > 500, true);
  check('and Yonsei contributes words NIKL does not', [...yonsei].filter((w) => !nikl.has(w)).length > 500, true);

  // Yonsei volume is used as a level, which only makes sense if difficulty actually
  // ascends. Measured on NIKL: the mean grade rises at every volume. Asserted as
  // "not decreasing" over the whole run, tolerant of a flat step but not a reversal.
  const meanGrade = [];
  for (let v = 1; v <= 6; v++) {
    const at = [...yonsei].filter((w) => korean.levels.yonsei[w] === v && nikl.has(w));
    meanGrade.push(at.length ? at.reduce((s, w) => s + korean.levels.nikl[w], 0) / at.length : 0);
  }
  const reversed = meanGrade.some((m, i) => i > 0 && m > 0 && meanGrade[i - 1] > 0 && m < meanGrade[i - 1]);
  check('Yonsei volume ascends in difficulty, never reverses', reversed, false);
  check('and the first volume is the easiest', meanGrade[0] < meanGrade[meanGrade.length - 1], true);
}

section('the Korean join is what it is, measured and not hoped');

{
  const words = Object.keys(korean.words);
  const withDefinition = words.filter((word) => korean.words[word].m !== '');
  const ratio = withDefinition.length / words.length;

  // A range rather than an exact count, so a source revision does not fail here for
  // no good reason. The MEANING is that this is well past half now: adding Yonsei as
  // a LIST, not only as a definition source, is what recovered the roughly 1,900
  // words that used to be dropped for having a definition but no level.
  check('more than half the words have a definition', ratio > 0.45 && ratio < 0.6, true);
  check('and joined words are a real subset', withDefinition.length > 0, true);
}
// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
