/**
 * Rendering the learning layer into transcript lines and captions.
 *
 * **Shared by the side panel and the video viewer.** Both draw the same thing, a
 * line of `.mark` / `.word` spans with optional `.ruby` annotations and a definition
 * on hover, so the rendering lives in one place and both import it. A second
 * implementation in the viewer would drift, and the symptom would be captions whose
 * marks or popover behaved differently from the transcript's for no stated reason.
 *
 * It lives in `common/` rather than under `sidepanel/` for exactly that reason.
 *
 * Two decisions worth knowing:
 *
 *   - **Hover is delegated, not per-token.** A 5,000-character transcript is some
 *     3,400 tokens, and attaching a listener to each would cost more in memory than
 *     the whole transcript. One listener on the container reads `event.target`.
 *   - **Only definable tokens are interactive.** An unknown word has nothing to
 *     show, so it stays inert text rather than becoming a span that looks clickable
 *     and does nothing.
 *
 * It does NOT fetch definitions. A caller supplies the `{word, entry, levels}` for
 * a hovered token, the panel asks the worker, the viewer looks it up in the
 * dictionary it already holds, and this module only decides how that is drawn. That
 * is what lets the same code serve a surface that talks to the worker and one that
 * deliberately does not.
 */

import { levelColour, pinyinToNumbers } from '../learn/wordlist.js';
import { romanizeKana, romanizeHangul } from '../learn/readings.js';

/**
 * @typedef {Object} Token
 * @property {string} text
 * @property {number|null} level  Null when the word carries no mark.
 */

/**
 * Build the text of one transcript line.
 *
 * A word becomes interactive whenever we hold a definition for it, whether or
 * not it carries a mark. Conflating the two was a real bug: on HSK 2.0, 这样 and
 * 这么 have no level, so they rendered as bare text and had no hover, whole
 * sentences looked unmarked and undefined even though the words were known.
 *
 * So there are three cases, not two:
 *   - unknown to us        → plain text, nothing to show
 *   - known, no level here → hoverable, no underline
 *   - known and levelled   → hoverable, underlined in its level's colour
 *
 * @param {Array<{text: string, defined?: boolean, level: number|null}>} tokens
 * @param {number} levelCount  Total levels in the list being used, for the ramp.
 * @param {string[]} [palette]
 * @returns {DocumentFragment}
 */
export function renderTokens(tokens, levelCount, palette) {
  const fragment = document.createDocumentFragment();

  for (const token of tokens) {
    if (!token.defined) {
      // Nothing to define, so nothing to interact with.
      fragment.append(document.createTextNode(token.text));
      continue;
    }

    const span = document.createElement('span');
    span.textContent = token.text;
    span.dataset.word = token.text;

    if (token.level === null || token.level === undefined) {
      // A word we can define but this list does not place. Styled as a word, not
      // as a mark, so it reads as ordinary text that happens to be hoverable.
      span.className = 'word';
    } else {
      span.className = 'mark';
      // The colour is computed here rather than in CSS because it depends on the
      // list's length, which CSS cannot know.
      span.style.setProperty('--mark', levelColour(token.level, levelCount, palette));
    }

    fragment.append(span);
  }

  return fragment;
}

/**
 * Render tokens with their readings, according to the placement in force.
 *
 * Returns the same thing `renderTokens` does, so a caller can use either without
 * knowing which it got. When no reading is being shown, the default, this IS
 * `renderTokens`, and the extra work is one comparison per token.
 *
 * The placement is read from the LAST state the panel received rather than passed
 * in, because it arrives on every state push and threading it through three call
 * sites would be three places to forget it. That is the same arrangement
 * `renderTokens` already uses for `levelCount` and `palette`.
 *
 * @param {Array<{text: string, defined?: boolean, level: number|null, reading?: string|null}>} tokens
 * @param {number} levelCount
 * @param {string[]} [palette]
 * @returns {DocumentFragment}
 */
export function renderReading(tokens, levelCount, palette) {
  const placement = readingPlacement();
  if (placement === 'off' || placement === 'marked') {
    // `marked` shares this path because the placement decides per TOKEN, below.
    if (placement === 'off') return renderTokens(tokens, levelCount, palette);
  }

  if (placement === 'below') {
    // The text, then one line of readings under it. Cheaper to draw than ruby and
    // it reads as a conversion rather than as annotation.
    const fragment = renderTokens(tokens, levelCount, palette);
    const line = document.createElement('span');
    line.className = 'reading-line';

    // Separators are explicit text nodes rather than the strings `append` accepts,
    // because a raw string is not a node: `textContent` on the parent cannot read
    // it, so the spaces were invisible to the test while being present on screen.
    // Writing them out is also what keeps the readings from running together,
    // which matters here in a way it does not in ruby, ruby has one reading per
    // word and this is a single run.
    let first = true;
    for (const token of tokens) {
      // The computing entry point, so a token with no dictionary reading still
      // contributes one when its script allows it. This is the whole point of the
      // fallback: the `below` line and the ruby annotation must agree, and they
      // would not if one consulted the table and the other did not.
      const reading = readingFor(token);
      if (!reading) continue;
      if (!first) line.append(document.createTextNode(' '));
      first = false;
      const span = document.createElement('span');
      span.textContent = formatReading(reading);
      line.append(span);
    }
    fragment.append(line);
    return fragment;
  }

  // `above` and `marked`: the reading sits over its own word, and `marked` skips
  // the words the list does not place beyond the threshold, which are exactly the
  // words with no mark, so the annotation lands where attention already is.
  //
  // **`<ruby>` and `<rt>`, not spans.** That is the element pair that MEANS
  // "annotation over base text", so assistive technology reads the base and skips
  // or separates the annotation. A generic span instead puts `wǒmen` inside the
  // line's text content, and then anything reading `.textContent`, a screen
  // viewer, a copy, a test asserting the line still says what it said, sees the
  // pinyin interleaved with the characters. The browser suite caught exactly that.
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    // Computed here rather than read off the token, so a token the dictionary
    // cannot define still gets a reading when its script allows one. See
    // `readingFor`.
    const reading = readingFor(token);
    const wanted =
      reading &&
      (placement === 'above' || (token.level !== null && token.level !== undefined));

    if (!wanted) {
      fragment.append(renderTokens([token], levelCount, palette));
      continue;
    }

    const ruby = document.createElement('ruby');
    ruby.className = 'ruby';
    // ORDER MATTERS, and it is the spec's order: the base text comes FIRST and the
    // annotation after it, `<ruby>base<rt>annotation</rt></ruby>`. Appending the
    // `<rt>` first is invalid and Chrome lays it out wrong, the reading ends up
    // offset well to the left of the character it annotates, which reads as a layout
    // bug in our CSS and is really malformed markup. Measured: the reading sat 16px
    // left of its base's centre.
    ruby.append(renderTokens([token], levelCount, palette));
    const rt = document.createElement('rt');
    rt.className = 'rt';
    rt.textContent = formatReading(reading);
    ruby.append(rt);
    fragment.append(ruby);
  }
  return fragment;
}

/**
 * The reading settings in force, pushed in by the panel on every state.
 *
 * An explicit setter rather than the module reading the panel's own `view`,
 * which would be a circular import, and rather than a global, which would be a
 * second place for the truth to live.
 *
 * Three fields, because they are independent questions: WHERE a reading goes, HOW
 * a Chinese reading is written, and which SCRIPT each language's reading is drawn
 * in. `language` is not a setting at all; it is which language is on screen, and
 * the script fields are read through it.
 *
 * @type {{romaji: string, chineseScript: string, language: string,
 *   japaneseScript: string, koreanScript: string}}
 */
let readingSettings = {
  romaji: 'off',
  chineseScript: 'marks',
  language: '',
  japaneseScript: 'kana',
  koreanScript: 'romaja',
};

/**
 * @param {{romaji?: string, chineseScript?: string, language?: string,
 *   japaneseScript?: string, koreanScript?: string}|undefined} settings
 */
export function setReadingSettings(settings) {
  readingSettings = {
    romaji: settings?.romaji ?? 'off',
    chineseScript: settings?.chineseScript ?? 'marks',
    language: settings?.language ?? '',
    japaneseScript: settings?.japaneseScript ?? 'kana',
    koreanScript: settings?.koreanScript ?? 'romaja',
  };
}

/**
 * The reading to DRAW for a token, or null when there is none to draw.
 *
 * **Two sources, in order of authority:**
 *
 *   1. The dictionary entry, which is lexical and correct: 종로 is `jongno`
 *      because the sound rules cross the syllable boundary, and only the entry
 *      knows that.
 *   2. A script-level fallback, COMPUTED from the text, for whatever the
 *      dictionary has no entry for: particles, verb endings, lone syllables.
 *      Measured on realistic subtitles, that is 38% of Korean tokens and 35% of
 *      Japanese tokens, so it is the common case rather than an edge one.
 *
 * **Why the fallback lives here and not in the worker.** It is a presentation
 * choice, so computing it at render time means switching scripts is a repaint
 * rather than a re-mark: no worker round trip, no re-segmentation, and none of
 * the cache keys in `service-worker.js` that a new marking-time setting has to be
 * registered in. That is not just less code, it removes the class of bug where a
 * setting appears to do nothing because a cache key was not updated.
 *
 * Hanzi and kanji have no fallback on purpose. A character's reading is lexical
 * (阿姨 is `āyí`, not `yí`), so a table would be wrong about half the time; a
 * Chinese token with no entry genuinely has no reading to show.
 *
 * @param {{text: string, reading?: string|null, alternate?: string|null,
 *   respelling?: string|null}} token
 * @returns {string|null}
 */
function readingFor(token) {
  const language = readingSettings.language;
  const entry = token.reading ?? null;

  if (language === 'ja') {
    if (readingSettings.japaneseScript === 'none') return null;
    // `kana` shows what the entry holds, and NOTHING when there is no entry: a kana
    // word's text is already kana, so showing the text as its own "reading" is the
    // same string twice, which is what made this look like it worked.
    if (readingSettings.japaneseScript === 'kana') return entry;
    // Rōmaji CONVERTS, so it works for anything kana, entry or not. That is the
    // whole gain: とても has no useful kana reading but does have `totemo`.
    return romanizeKana(entry ?? token.text);
  }

  if (language === 'ko') {
    if (readingSettings.koreanScript === 'none') return null;
    if (readingSettings.koreanScript === 'hangul') {
      // The source's own respelling, which shows the sound changes and the vowel
      // length but stays in Hangul. Null when the source has none, because a
      // Hangul text shown as its own Hangul "reading" is the duplicate problem
      // again.
      return token.respelling ?? null;
    }
    if (readingSettings.koreanScript === 'spelling') {
      // The spelling form where the entry has one, and the syllable table
      // otherwise. The table is a pronunciation form, so this is approximate for a
      // word with no entry, which is honest: there is no spelling form to know.
      return token.alternate ?? entry ?? romanizeHangul(token.text);
    }
    // The entry is authoritative where there is one; otherwise the syllable table,
    // which is exact for a LONE syllable and wrong across a boundary, so it is only
    // ever consulted when no entry exists.
    return entry ?? romanizeHangul(token.text);
  }

  // Chinese and anything else: the entry or nothing. A hanzi has no derivable
  // reading, so there is no fallback to compute. `none` is handled by the caller
  // through the placement, and `numbers` is a rewrite applied when the reading is
  // WRITTEN rather than here, because it is the same string in another notation.
  if (readingSettings.chineseScript === 'none') return null;
  return entry;
}

/**
 * The reading placement in force.
 *
 * @returns {string}
 */
function readingPlacement() {
  return readingSettings.romaji;
}

/**
 * A reading as it should be written.
 *
 * Tone numbers are a Chinese convention with no Japanese equivalent, and the
 * conversion leaves kana alone either way, so this needs no language check. The
 * notation is carried by `chineseScript`, which absorbed the old `toneStyle`.
 *
 * @param {string} reading
 * @returns {string}
 */
function formatReading(reading) {
  if (!reading) return '';
  return readingSettings.chineseScript === 'numbers' ? pinyinToNumbers(reading) : reading;
}

/** Where the hover panel sits, created once. */
let popover = null;

/** @returns {HTMLElement} */
function ensurePopover() {
  if (popover) return popover;

  popover = document.createElement('div');
  popover.className = 'popover';
  popover.hidden = true;
  document.body.append(popover);
  return popover;
}

/**
 * Attach hover handling to a container, once.
 *
 * Selects both classes: a `.mark` carries a level, a `.word` does not, but both
 * can be defined and so both should respond.
 *
 * @param {HTMLElement} container
 * @param {(word: string) => void} onHover  Called with the word under the pointer.
 * @returns {() => void} Detach.
 */
export function attachHover(container, onHover) {
  let current = null;
  const INTERACTIVE = '.mark, .word';

  const over = (event) => {
    const target = event.target.closest?.(INTERACTIVE);
    if (!target || target === current) return;
    current = target;
    onHover(target.dataset.word);
    showAt(popoverFor(target));
  };

  const out = (event) => {
    const target = event.target.closest?.(INTERACTIVE);
    if (!target || target !== current) return;
    // Moving between words hides then shows, which is fine and avoids tracking
    // pointer position continuously.
    if (event.relatedTarget?.closest?.(INTERACTIVE) === target) return;
    current = null;
    hide();
  };

  container.addEventListener('mouseover', over);
  container.addEventListener('mouseout', out);

  return () => {
    container.removeEventListener('mouseover', over);
    container.removeEventListener('mouseout', out);
    hide();
  };
}

/**
 * Anchor the popover to a token.
 *
 * @param {HTMLElement} token
 * @returns {HTMLElement}
 */
function popoverFor(token) {
  const node = ensurePopover();
  const box = token.getBoundingClientRect();
  // Fixed positioning against the viewport, so it works inside the scroller
  // without having to account for scroll offset.
  node.style.left = `${Math.min(box.left, window.innerWidth - 260)}px`;
  node.style.top = `${box.bottom + 6}px`;
  return node;
}

/** @param {HTMLElement} node */
function showAt(node) {
  node.hidden = false;
}

export function hide() {
  if (popover) popover.hidden = true;
}

/**
 * Fill and show the popover for a looked-up word.
 *
 * @param {{word: string, entry: {p?: string, m?: string, t?: string, pos?: string}|null,
 *          levels: Array<{id: string, label: string, level: number, levelCount: number}>|null}} result
 */
export function showEntry(result) {
  const node = ensurePopover();
  node.replaceChildren();

  const head = document.createElement('div');
  head.className = 'popover-head';

  const word = document.createElement('strong');
  word.textContent = result.word;
  head.append(word);

  // A word with a definition but no level is a real case, not an error: the
  // graded lists do not contain everything. It gets a definition and no badge.
  const heading = result.entry;
  if (heading?.p) {
    const pinyin = document.createElement('span');
    pinyin.className = 'popover-pinyin';
    pinyin.textContent = heading.p;
    head.append(pinyin);
  }
  node.append(head);

  if (heading?.m) {
    const meaning = document.createElement('div');
    meaning.className = 'popover-meaning';
    meaning.textContent = heading.m;
    node.append(meaning);
  } else {
    const missing = document.createElement('div');
    missing.className = 'popover-meaning popover-missing';
    missing.textContent = 'No definition for this word yet.';
    node.append(missing);
  }

  if (result.levels?.length) {
    const badges = document.createElement('div');
    badges.className = 'popover-badges';
    for (const level of result.levels) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      // The list's own NAME for the level, never the stored number. JLPT names
      // its levels N5..N1, easiest first, so printing the stored 1 as "1" read
      // as N1, the hardest, on 私. `levelName` carries the name; the number is
      // only an ordering.
      badge.textContent = `${level.label} ${level.levelName ?? level.level}`;
      // Coloured with the same ramp the underline uses, so the badge and the
      // mark agree about what level this is.
      badge.style.setProperty('--mark', levelColour(level.level, level.levelCount));
      badges.append(badge);
    }
    node.append(badges);
  }

  if (heading?.t && heading.t !== result.word) {
    const traditional = document.createElement('div');
    traditional.className = 'popover-traditional';
    traditional.textContent = heading.t;
    node.append(traditional);
  }

  node.hidden = false;
}
