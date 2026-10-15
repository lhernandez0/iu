/**
 * Tests for the viewer's keyboard shortcut table and resolver.
 *
 * **These are the two places a keyboard layer actually breaks.** The ACTION functions
 * were already tested through the buttons that share them, and the wiring is a single
 * `switch`; what is not otherwise covered is which key maps to which action, and the
 * rules about when a key is the player's to handle at all. Both are pure, so both are
 * checked here rather than in a browser, where the same mistakes are slower to catch.
 *
 * The rules are the important half. A shortcut layer that fires while a text field has
 * focus, or that swallows `Ctrl+L`, is worse than one with a missing key: the missing key
 * is noticed, the stolen one is blamed on the browser.
 *
 * Run: node test/shortcuts.test.mjs (or `npm test`)
 */

import { SHORTCUTS, SHORTCUT_IDS, resolveShortcut, jumpFraction } from '../src/viewer/shortcuts.js';
import { SPEED_VALUES } from '../src/common/settings.js';

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

/**
 * A keyboard event shaped like a real one, with the fields the resolver reads.
 *
 * @param {string} key
 * @param {Partial<{repeat: boolean, ctrlKey: boolean, metaKey: boolean, altKey: boolean, defaultPrevented: boolean, target: object}>} [overrides]
 */
const key = (key, overrides = {}) => ({
  key,
  repeat: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  defaultPrevented: false,
  target: { tagName: 'BODY' },
  ...overrides,
});

// --- The table ---------------------------------------------------------------

section('the shortcut table');

{
  // Every id is distinct, or the `switch` in the viewer would have a case that can
  // never run and a key that silently does nothing.
  check('every action id is unique', new Set(SHORTCUT_IDS).size, SHORTCUT_IDS.length);
  check('every entry has at least one key', SHORTCUTS.every((e) => e.keys.length > 0), true);
  check('every entry has a label and a group', SHORTCUTS.every((e) => e.label && e.group), true);

  // The keys shown in the help must be unique, or two actions claim one key and the
  // resolver can only honour one of them, so the panel would teach a key that does not
  // do what it says.
  const shown = SHORTCUTS.flatMap((e) => e.keys);
  check('no key is claimed by two actions', new Set(shown).size, shown.length);
}

// --- Resolution: the happy path ----------------------------------------------

section('the keys resolve to the actions they are documented as');

{
  // Derived FROM the table, so this cannot drift: whatever the help lists is what is
  // checked. The display form and the matching form are different (Space is `' '`,
  // arrows are `'\u2190'` not `'ArrowLeft'`), so the display key is fed through the
  // same normalisation the resolver uses and the result compared to the action.
  const mismatches = [];
  for (const entry of SHORTCUTS) {
    for (const shown of entry.keys) {
      const probe = shown === 'Space' ? ' ' : shown === '\u2190' ? 'ArrowLeft' : shown === '\u2192' ? 'ArrowRight' : shown;
      const got = resolveShortcut(key(probe));
      if (got !== entry.id) mismatches.push(`${shown} -> ${got}, expected ${entry.id}`);
    }
  }
  check('every documented key resolves to its own action', mismatches, []);

  // Case-insensitivity is not cosmetic: a real `keydown` for a letter is lowercase
  // unless Shift is held, and `?` arrives as `'?'` while the letter keys arrive as
  // `'k'`. Both cases are probed so a fix that only handles one is caught.
  check('an uppercase letter resolves like its lowercase', resolveShortcut(key('K')), 'play');
  check('and the lowercase one', resolveShortcut(key('k')), 'play');
}

// --- Resolution: the guard rules ---------------------------------------------

section('modifiers are never intercepted');

{
  // The rule that keeps the browser's own shortcuts working. Each is checked
  // separately because a fix that only tested `ctrlKey` would leave `Cmd+Q` and
  // `Alt+Left` broken, and those are the two that lose data or navigate away.
  check('Ctrl+L is left to the browser', resolveShortcut(key('l', { ctrlKey: true })), null);
  check('Cmd+L is left to the browser', resolveShortcut(key('l', { metaKey: true })), null);
  check('Alt+Left is left to the browser', resolveShortcut(key('ArrowLeft', { altKey: true })), null);
  check('Ctrl+Space is left to the browser', resolveShortcut(key(' ', { ctrlKey: true })), null);
  // Shift is the exception, and it has to be: `?` IS Shift+Slash on most layouts, so
  // refusing every shifted key would make the help key unreachable.
  check('but Shift is allowed, so ? still works', resolveShortcut(key('?')), 'help');
}

section('a focused control keeps the key');

{
  // At the element level rather than by key, so `k` in a search field inserts a `k`
  // instead of toggling playback, which is the bug this rule exists for.
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
    check(`${tagName} swallows k`, resolveShortcut(key('k', { target: { tagName } })), null);
  }
  // Anything else is the player's, so the guard cannot be "only BODY works", which
  // would break the common case of the event targeting a div inside the page.
  check('a div does not swallow k', resolveShortcut(key('k', { target: { tagName: 'DIV' } })), 'play');
  check('a null target does not swallow k', resolveShortcut(key('k', { target: null })), 'play');
}

section('a handled event is not handled twice');

{
  // The page and the native player share one document. If something already called
  // `preventDefault`, the key was theirs, and acting on it too would double the
  // effect: a 5 second skip becoming 10.
  check('a prevented key is ignored', resolveShortcut(key('l', { defaultPrevented: true })), null);
}

section('only seeking repeats');

{
  // Holding a seek key to scrub is how a transport is used; holding a toggle is a
  // mistake. Both directions are asserted, so a rule of "never repeat" and a rule of
  // "always repeat" each fail this.
  check('a repeat of forward still seeks', resolveShortcut(key('l', { repeat: true })), 'forward');
  check('a repeat of back still seeks', resolveShortcut(key('j', { repeat: true })), 'back');
  check('a repeat of play is ignored', resolveShortcut(key('k', { repeat: true })), null);
  check('a repeat of captions is ignored', resolveShortcut(key('c', { repeat: true })), null);
  check('and a repeat of the next-line key is ignored', resolveShortcut(key(']', { repeat: true })), null);
}

section('unbound keys are left alone');

{
  // The keys deliberately not bound. `/` is the browser's quick-find and the viewer
  // has no search; a chapter key needs a chapter model the parser does not have.
  check('slash is not bound', resolveShortcut(key('/')), null);
  check('the N playlist key is not bound', resolveShortcut(key('N')), null);
  check('a bare letter that means nothing is not bound', resolveShortcut(key('q')), null);
  check('an unbound repeat is not bound', resolveShortcut(key('q', { repeat: true })), null);
}

// --- The number keys ---------------------------------------------------------

section('the number keys carry their fraction');

{
  // The id is the only place the number lives, so the parse is checked in both
  // directions: the key resolves to the id, and the id yields the fraction. A typo
  // in either would make `5` seek somewhere other than the middle.
  check('5 resolves to jump-5', resolveShortcut(key('5')), 'jump-5');
  check('and jump-5 is the middle', jumpFraction('jump-5'), 0.5);
  check('0 resolves to jump-0', resolveShortcut(key('0')), 'jump-0');
  check('and jump-0 is the start', jumpFraction('jump-0'), 0);
  check('9 is ninety percent', jumpFraction('jump-9'), 0.9);
  check('a non-jump action has no fraction', jumpFraction('play'), null);
  check('and a malformed one has none either', jumpFraction('jump-'), null);
}

// --- The speed keys match the picker -----------------------------------------

section('the speed ladder the keys step through is the picker\'s own');

{
  // `<` and `>` step `SPEED_VALUES`, so this pins that the list exists and is
  // ascending, which is what makes "step one and clamp" mean what it says. A
  // descending list would make `>` slow the film down, which no test above would
  // notice because the stepping itself is in the viewer.
  const numeric = SPEED_VALUES.map(Number);
  const ascending = numeric.every((value, i) => i === 0 || value > numeric[i - 1]);
  check('the ladder is ascending', ascending, true);
  check('and it starts below 1', Number(SPEED_VALUES[0]) < 1, true);
  check('and ends above 1', Number(SPEED_VALUES.at(-1)) > 1, true);
  check('and contains exactly one 1x', SPEED_VALUES.filter((v) => Number(v) === 1).length, 1);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
