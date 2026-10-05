/**
 * Rendering the learning layer into transcript lines.
 *
 * Kept apart from the panel's own state machine because it is self-contained:
 * given a line's tokens it produces a node, and it is the only place that knows
 * how a mark looks. The panel does not need to understand levels.
 *
 * Two decisions worth knowing:
 *
 *   - **Hover is delegated, not per-token.** A 5,000-character transcript is
 *     some 3,400 tokens, and attaching a listener to each would cost more in
 *     memory than the whole transcript. One listener on the container reads
 *     `event.target` instead.
 *   - **Only marked tokens are interactive.** An unmarked word has nothing to
 *     show, so it stays inert text rather than becoming a span that looks
 *     clickable and does nothing.
 */

import { levelColour } from '../learn/wordlist.js';

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
 * 这么 have no level, so they rendered as bare text and had no hover — whole
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
      badge.textContent = `${level.label} ${level.level}`;
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
