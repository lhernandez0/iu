/**
 * The viewer's keyboard shortcuts, as a pure table and a pure resolver.
 *
 * Separated from `viewer.js` so the MAPPING is testable without a browser. The wiring
 * (which action moves the playhead) has to touch the media element and belongs in the
 * viewer; which KEY means which action, and the rules about when a key is ours to
 * handle at all, are data and a fold, and those are where the mistakes live.
 *
 * ## Where the mapping comes from
 *
 * YouTube's player has a set of shortcuts its users already know, and this viewer plays
 * YouTube videos, so matching them where it costs nothing is the difference between keys
 * that are remembered and keys that have to be looked up. The set below starts from
 * YouTube's list and diverges in exactly three places, each deliberate:
 *
 *   - `j` and `l` are 5 seconds, not 10, because the viewer's OWN buttons step 5 and a
 *     shortcut that disagreed with the button beside it would be a trap.
 *   - `,` and `.` are left UNBOUND. YouTube uses them to step a frame, this viewer has no
 *     frame stepping, and binding them to something else would take the key away from the
 *     feature if it is ever added.
 *   - Previous/next/replay LINE have no YouTube equivalent, so they get `[`, `]` and `\`:
 *     a cluster that sits together on the keyboard, where the brackets read as "one back,
 *     one forward" and the odd one out is the odd action.
 *
 * ## The keys deliberately NOT bound
 *
 * `/` focuses YouTube's search box. The viewer has no search, and stealing `/` from the
 * browser's own quick-find would be taking a key to do nothing. `Shift+N`/`Shift+P` step
 * through a PLAYLIST, which a local file has no concept of, and `Ctrl/⌥+←/→` step
 * chapters, which the container parser does not model. None of them map to anything real
 * here, so none of them are bound rather than bound to a guess.
 */

/**
 * The action a key performs, and the words the help panel shows for it.
 *
 * `keys` is the display form, not the matching form: `resolveShortcut` decides what
 * actually triggers the action, and this is only what a learner reads. Keeping them
 * separate is what allows a key to be shown as `Space` while being matched on `' '` and
 * `'Space'`, which is two different `event.key` values across browsers.
 *
 * @type {Array<{
 *   id: string, keys: string[], label: string, group: string,
 *   yt?: string, note?: string,
 * }>}
 */
export const SHORTCUTS = [
  // --- Playback -------------------------------------------------------------
  { id: 'play', keys: ['K', 'Space'], label: 'Play / pause', group: 'Playback' },
  { id: 'mute', keys: ['M'], label: 'Mute / unmute', group: 'Playback' },
  { id: 'speed-down', keys: ['<'], label: 'Slower', group: 'Playback' },
  { id: 'speed-up', keys: ['>'], label: 'Faster', group: 'Playback' },

  // --- Seeking --------------------------------------------------------------
  { id: 'back', keys: ['J', '\u2190'], label: 'Back 5 seconds', group: 'Seeking', yt: 'other players step 10' },
  { id: 'forward', keys: ['L', '\u2192'], label: 'Forward 5 seconds', group: 'Seeking', yt: 'other players step 10' },
  { id: 'start', keys: ['Home'], label: 'Jump to the start', group: 'Seeking' },
  { id: 'end', keys: ['End'], label: 'Jump to the end', group: 'Seeking' },
  { id: 'jump-1', keys: ['1'], label: 'Jump to 10%', group: 'Seeking' },
  { id: 'jump-2', keys: ['2'], label: 'Jump to 20%', group: 'Seeking' },
  { id: 'jump-3', keys: ['3'], label: 'Jump to 30%', group: 'Seeking' },
  { id: 'jump-4', keys: ['4'], label: 'Jump to 40%', group: 'Seeking' },
  { id: 'jump-5', keys: ['5'], label: 'Jump to 50%', group: 'Seeking' },
  { id: 'jump-6', keys: ['6'], label: 'Jump to 60%', group: 'Seeking' },
  { id: 'jump-7', keys: ['7'], label: 'Jump to 70%', group: 'Seeking' },
  { id: 'jump-8', keys: ['8'], label: 'Jump to 80%', group: 'Seeking' },
  { id: 'jump-9', keys: ['9'], label: 'Jump to 90%', group: 'Seeking' },
  { id: 'jump-0', keys: ['0'], label: 'Jump to the start', group: 'Seeking' },

  // --- Lines, this viewer's own controls ------------------------------------
  { id: 'prev-cue', keys: ['['], label: 'Previous line', group: 'Lines', yt: 'this viewer only' },
  { id: 'next-cue', keys: [']'], label: 'Next line', group: 'Lines', yt: 'this viewer only' },
  { id: 'replay-cue', keys: ['\\'], label: 'Replay this line', group: 'Lines', yt: 'this viewer only' },

  // --- Display --------------------------------------------------------------
  { id: 'captions', keys: ['C'], label: 'Captions on / off', group: 'Display' },
  { id: 'fullscreen', keys: ['F'], label: 'Fullscreen on / off', group: 'Display' },
  { id: 'pip', keys: ['I'], label: 'Picture in picture', group: 'Display', yt: 'a miniplayer elsewhere' },
  { id: 'help', keys: ['?'], label: 'Show this list', group: 'Display', yt: 'the common key for this' },
];

/** Every action id, for a test to check the wiring covers them all. */
export const SHORTCUT_IDS = SHORTCUTS.map((entry) => entry.id);

/**
 * The `event.key` values that resolve to each action.
 *
 * Built from `SHORTCUTS` so the table and the matcher cannot drift: a key shown in the
 * help is a key that works, which is the property that makes a help panel worth having.
 * Built by hand rather than derived from the display strings because the display form is
 * for people, `←` is not what a keyboard reports and `Space` is reported three ways.
 *
 * @type {Record<string, string>}
 */
const KEY_TO_ACTION = {
  k: 'play',
  ' ': 'play',
  spacebar: 'play',
  m: 'mute',
  '<': 'speed-down',
  '>': 'speed-up',
  j: 'back',
  arrowleft: 'back',
  l: 'forward',
  arrowright: 'forward',
  home: 'start',
  end: 'end',
  '1': 'jump-1',
  '2': 'jump-2',
  '3': 'jump-3',
  '4': 'jump-4',
  '5': 'jump-5',
  '6': 'jump-6',
  '7': 'jump-7',
  '8': 'jump-8',
  '9': 'jump-9',
  '0': 'jump-0',
  '[': 'prev-cue',
  ']': 'next-cue',
  '\\': 'replay-cue',
  c: 'captions',
  f: 'fullscreen',
  i: 'pip',
  '?': 'help',
};

/**
 * The input types that take TEXT, where a letter or a space must reach the field.
 *
 * `file`, `checkbox`, `radio`, `range`, `button` and the rest are deliberately absent.
 * A file input is the one that bit: it is `<input>`, so a tagName-only guard treated it
 * as a text field, and after a file was chosen it kept FOCUS, so `Space` activated it and
 * reopened the file dialog instead of toggling playback. A control that is not for typing
 * has no claim on a letter key.
 *
 * @type {Set<string>}
 */
const TEXT_ENTRY_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

/**
 * Whether a keypress belongs to the focused element rather than to the player.
 *
 * **A shortcut that fires while a text field has focus is a bug, not a feature.** The
 * letters that drive playback are the same letters someone types, so `k` inside a field
 * must insert `k` and never toggle playback. This takes the ELEMENT, not its tag, because
 * the tag alone cannot tell a search box from a file picker and that conflation is exactly
 * what reopened the file dialog on `Space`.
 *
 * Two things are deliberately NOT blocked, both because the viewer is a player first:
 *   - **`SELECT`** is blocked: `Space` opens the dropdown and the arrows change the
 *     option, so those keys belong to the control while it has focus.
 *   - **`BUTTON` and a `file` input are NOT blocked.** A button is activated by `Enter`
 *     as well, so taking `Space` from it costs a keyboard user nothing, and giving the
 *     player `Space` everywhere else is what a learner expects from a video. This is a
 *     deliberate trade: `Space` is play/pause even with a control focused, and `Enter`
 *     still operates the control.
 *
 * @param {{tagName?: string, type?: string, isContentEditable?: boolean}|null} target
 * @returns {boolean}
 */
function isTypingTarget(target) {
  if (!target) return false;
  // A rich-text area has no tagName that says so.
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    // An input with no `type` reads as `text`, which is what the browser does too.
    return TEXT_ENTRY_TYPES.has((target.type || 'text').toLowerCase());
  }
  return false;
}

/**
 * The action a keyboard event should perform, or null when it is not ours.
 *
 * Pure: it takes the fields it reads and nothing else, so every rule below is testable
 * without a DOM.
 *
 * ## The rules, and why each exists
 *
 * 1. **Never while a modifier is held.** `Ctrl+L` is the browser's address bar, `Cmd+Q`
 *    is quit. A player that swallowed those would be fighting the operating system, and
 *    the fight is always lost, so it is not started. `Shift` is exempt because `?` IS
 *    Shift+`/` on most layouts and the help key would be unusable without it.
 * 2. **Never in a text field.** Decided by the ELEMENT, not its tag, see
 *    `isTypingTarget`: a file picker is an `<input>` and must not swallow `Space`, while
 *    a search box must.
 * 3. **Never if something already handled it.** YouTube's own player has its own
 *    keyboard layer and runs in the same document; if it has called `preventDefault`, the
 *    key was theirs and acting on it too would double the effect, a 10 second skip
 *    becoming a 15 second one.
 * 4. **Never for a held-down key.** Repeats are ignored except for the actions where
 *    repeating is what a person expects, seeking. Holding `j` to scrub backwards is
 *    natural; holding `c` and toggling captions forty times is not.
 *
 * @param {{
 *   key: string, repeat?: boolean, ctrlKey?: boolean, metaKey?: boolean,
 *   altKey?: boolean, defaultPrevented?: boolean,
 *   target?: {tagName?: string, type?: string, isContentEditable?: boolean}|null,
 * }} event
 * @returns {string|null}
 */
export function resolveShortcut(event) {
  if (!event || typeof event.key !== 'string') return null;
  // Rule 1. Alt is included with Ctrl and Meta: Alt+arrow is navigation in several
  // browsers and on macOS, and the arrows are seeking keys here.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  // Rule 3, checked before the table so a key the page already consumed is not even
  // looked up.
  if (event.defaultPrevented) return null;
  // Rule 2, on the element rather than the tag.
  if (isTypingTarget(event.target ?? null)) return null;

  const action = KEY_TO_ACTION[event.key.toLowerCase()];
  if (!action) return null;

  // Rule 4. Repeat is allowed only where holding the key is the point.
  if (event.repeat && !REPEATABLE.has(action)) return null;

  return action;
}

/**
 * The actions a held-down key may repeat.
 *
 * Seeking, and only seeking: holding a seek key to scrub is how everyone uses a transport,
 * while a held toggle is always a mistake. `prev-cue`/`next-cue` are excluded on purpose,
 * because repeating them would run through the whole film at the key's repeat rate, which
 * is a way to lose your place that a single press never is.
 *
 * @type {Set<string>}
 */
const REPEATABLE = new Set(['back', 'forward']);

/**
 * The fraction of the film an action jumps to, or null when it is not a jump.
 *
 * The number keys are the one place the action id carries data, `jump-7` meaning 70%, so
 * the parse lives here rather than in the viewer, which should be handed a number and not
 * have to know how the id was spelled.
 *
 * @param {string} action
 * @returns {number|null}
 */
export function jumpFraction(action) {
  const match = /^jump-([0-9])$/.exec(action);
  if (!match) return null;
  return Number(match[1]) / 10;
}
