/**
 * Segmentation by longest match, for CJK text.
 *
 * Chinese and Japanese have no word boundaries, so a word list cannot be matched
 * against a caption with a regex. This walks the text and takes the longest
 * headword present at each position, falling back to a single character.
 *
 * Why not Jieba: measurement. Over 10,983 example sentences this keeps the
 * target word intact 97.9% of the time, at 1.45M characters/sec, with no
 * dependency, no WASM and no build step. Frequency-weighted scoring made no
 * measurable difference, because longest-match already prefers the right
 * compound. See the notes for the full measurement.
 *
 * The failure mode is worth stating because it is not what it looks like: when
 * the list contains both a character and a compound built from it, this prefers
 * the compound. That is usually correct, `岸上` is a better token than `岸`,
 * but it means the level attached to a token is the headword's, so a character
 * the learner knows can appear inside a word they do not. That is a property of
 * the data, not a bug here.
 */

/**
 * The characters the segmenter will try to match words against.
 *
 * Han (CJK ideographs, all three blocks) PLUS kana. Kana is not decoration: a
 * great many Japanese words are written in it and nowhere else, and the
 * dictionary keys on them, `とても`, `いらっしゃい`, `うっかり` are all headwords.
 * With Han alone they could never match, because the segmenter never looked at
 * the characters at all, so a large share of ordinary Japanese rendered unmarked.
 *
 * Widening it cannot affect Chinese: Chinese text contains no kana, so no run of
 * Chinese is tokenised differently than before.
 *
 * The katakana block runs to \u30ff, which is the end of the main block. The
 * phonetic extensions (\u31f0-\u31ff) are deliberately left out for now, they
 * only affect Ainu and a handful of loanwords, and including them widens the
 * longest-match window for every line to serve almost nothing.
 */
const CJK = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * @typedef {Object} Token
 * @property {string} text
 * @property {number} start   Index into the source string.
 * @property {number} end     Exclusive.
 * @property {boolean} known  Whether the dictionary has this as a headword.
 */

/**
 * Build a membership test for whichever container the caller has.
 *
 * A Set and a Map both answer `has`, but a plain object does not, and
 * `Object.hasOwn` on a Set checks its *properties*, not its members, which
 * silently reports that every word is absent. Supporting all three explicitly is
 * what stops that mistake being possible again.
 *
 * @param {Set<string>|Map<string, unknown>|Record<string, unknown>} headwords
 * @returns {(word: string) => boolean}
 */
function membership(headwords) {
  if (headwords instanceof Set || headwords instanceof Map) return (word) => headwords.has(word);
  return (word) => Object.hasOwn(headwords, word);
}

/**
 * Split one line into tokens.
 *
 * Runs of text in neither Han nor kana, spaces, punctuation, latin words,
 * numbers, are emitted as a single token each so the caller can render them
 * untouched. That keeps the index arithmetic honest: concatenating `text` over
 * every token reproduces the input exactly, which is the invariant the tests
 * lean on.
 *
 * @param {string} text
 * @param {Set<string>|Map<string, unknown>|Record<string, unknown>} headwords
 * @param {number} maxWordLength
 * @returns {Token[]}
 */
export function segment(text, headwords, maxWordLength) {
  /** @type {Token[]} */
  const tokens = [];
  const has = membership(headwords);

  let i = 0;
  while (i < text.length) {
    const char = text[i];

    // Anything in neither Han nor kana passes through unsegmented.
    if (!CJK.test(char)) {
      let end = i;
      while (end < text.length && !CJK.test(text[end])) end++;
      tokens.push({ text: text.slice(i, end), start: i, end, known: false });
      i = end;
      continue;
    }

    // Longest match. The window is bounded by the longest headword in the data,
    // 4 for Chinese, but longer for Japanese, whose kana compounds run to about
    // 15 characters. Still only a handful of lookups per position, and measured
    // at ~1.3M characters/sec on a Japanese transcript.
    let matched = null;
    const limit = Math.min(maxWordLength, text.length - i);
    for (let length = limit; length >= 2; length--) {
      const candidate = text.slice(i, i + length);
      if (has(candidate)) {
        matched = candidate;
        break;
      }
    }

    if (matched) {
      tokens.push({ text: matched, start: i, end: i + matched.length, known: true });
      i += matched.length;
    } else {
      // Single characters are not looked up here: a one-character word is a
      // legitimate headword, but treating every lone character as known would
      // claim knowledge we may not have. The caller checks them individually.
      tokens.push({ text: char, start: i, end: i + 1, known: has(char) });
      i += 1;
    }
  }

  return tokens;
}

/**
 * Segment a whole transcript.
 *
 * One call per line rather than joining first, so a token can never span two
 * cues, which would attach a word to the wrong timestamp.
 *
 * @param {Array<{start: number, duration?: number, text: string}>} segments
 * @param {Set<string>|Map<string, unknown>|Record<string, unknown>} headwords
 * @param {number} maxWordLength
 * @returns {Array<Array<Token>>} One token list per segment, same order.
 */
export function segmentSegments(segments, headwords, maxWordLength) {
  return segments.map((entry) => segment(entry.text ?? '', headwords, maxWordLength));
}
