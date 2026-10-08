/**
 * The extension's settings, defined once.
 *
 * Every setting the learner can change lives here as a declared entry rather
 * than as its own field, its own storage key and its own wiring. That is the
 * point: adding a setting should be one object in this file and one control
 * rendered from it, not three edits in three places that can disagree.
 *
 * A definition is also a schema — `options` drives the control, `default`
 * supplies a value before anything is stored, and `coerce` protects against a
 * stored value that no longer makes sense (a list that was removed, a size that
 * is nonsense). Settings are read from storage in one place and written in one
 * place.
 *
 * NOTE: nothing here may import from the side panel or the service worker.
 * Both sides use it, and the panel must be able to render a control for a
 * setting the worker has not heard of yet.
 */

/**
 * @typedef {Object} SettingDefinition
 * @property {string} id            Storage key and wire name.
 * @property {string} label         Shown beside the control.
 * @property {'select'|'number'|'map'} type
 * @property {any} default
 * @property {Array<{value: any, label: string}>} [options] For 'select'.
 * @property {number} [min]         For 'number'.
 * @property {number} [max]         For 'number'.
 * @property {number} [step]        For 'number'.
 * @property {string} [group]       Which section of the panel it belongs to.
 * @property {(value: any, context?: object) => any} [coerce] Normalise a stored value.
 * @property {boolean} [dynamic]    Options are supplied at render time, not here.
 * @property {boolean} [hidden]     A real setting with no control yet, for a future
 *                                  settings page. Not rendered by the toolbar.
 */

/**
 * How a known word is marked in the transcript.
 *
 * Two treatments, not a scale. They answer different questions:
 *   - `underline` points AT the word. The rule sits below the text and leaves the
 *     body of it completely untouched, so reading is unbroken.
 *   - `highlight` puts colour BEHIND the word. It reads from further away and
 *     makes marked words countable at a glance, at the cost of ink behind the
 *     glyphs.
 */
const MARK_STYLE_OPTIONS = [
  { value: 'underline', label: 'Underline' },
  { value: 'highlight', label: 'Highlight' },
];

/** The base size every other size in the panel is a multiple of. */
export const BASE_FONT_PX = 13;

/** How much of the transcript is shown at once. */
const VIEW_OPTIONS = [
  { value: 'all', label: 'Full' },
  { value: 'focus', label: 'Live' },
];

/**
 * How much of the panel's chrome is on screen.
 *
 * `full` keeps every control visible. `collapsed` reduces the bars to the two
 * language pickers and folds the reading controls away, so the transcript — which
 * is what the panel is for — gets the vertical space. A side panel is roughly
 * 600px tall on a laptop, and three bars plus a status line is a large fraction
 * of it.
 *
 * A setting rather than an automatic behaviour: whether the controls should yield
 * to the text depends on what you are doing, and guessing wrong either hides a
 * control you were reaching for or spends height you wanted for reading.
 */
const LAYOUT_OPTIONS = [
  { value: 'full', label: 'Full' },
  { value: 'collapsed', label: 'Collapsed' },
];

/**
 * Where a word's reading (拼音 / Rōmaji) is drawn.
 *
 * Four options rather than a checkbox, because they are genuinely different
 * layouts rather than degrees of one — decided by looking at all four on real
 * content, not by argument. `off` first because it is the default.
 */
const READING_OPTIONS = [
  { value: 'off', label: 'Off' },
  // Ruby: the reading above its own word, so every glyph keeps its horizontal
  // position and the line reads as one unit. Costs row height.
  //
  // Labels are SHORT because this is a `<select>` in a 350px bar shared with three
  // other controls. "Above each word" rendered clipped, and a control whose text
  // is cut off is worse than a terse one — the options themselves carry the
  // explanation. ("Above" means "above the word also above", which is what the
  // CSS namespace calls ruby, so that is what the option says.)
  { value: 'above', label: 'Above' },
  // One line under the text. Cheapest to draw, and it reads as a conversion
  // rather than as annotation — the eye travels between two lines instead of
  // staying on one.
  { value: 'below', label: 'Below' },
  // Only on words the highlight already covers. Row height unchanged, and the
  // annotation lands where attention already is.
  { value: 'marked', label: 'Marked' },
];

/** How a pinyin reading is written. */
const TONE_OPTIONS = [
  { value: 'marks', label: 'Tone marks (mā)' },
  { value: 'numbers', label: 'Numbers (ma1)' },
];

/**
 * Whether Chinese subtitles are rewritten to the other script.
 *
 * A display option and nothing more: the dictionary already resolves traditional
 * text, so nothing is broken without this. See the note on the setting itself.
 */
const SCRIPT_OPTIONS = [
  { value: 'off', label: 'As written' },
  { value: 't2s', label: 'Traditional → Simplified' },
  { value: 's2t', label: 'Simplified → Traditional' },
];

/**
 * @type {SettingDefinition[]}
 */
export const SETTINGS = [
  {
    id: 'view',
    label: 'Show',
    group: 'reading',
    type: 'select',
    options: VIEW_OPTIONS,
    default: 'all',
    coerce: (value) => (VIEW_OPTIONS.some((o) => o.value === value) ? value : 'all'),
  },
  {
    id: 'layout',
    label: 'Controls',
    group: 'reading',
    type: 'select',
    options: LAYOUT_OPTIONS,
    default: 'full',
    coerce: (value) => (LAYOUT_OPTIONS.some((o) => o.value === value) ? value : 'full'),
  },
  {
    id: 'fontSize',
    label: 'Text size',
    group: 'reading',
    type: 'number',
    default: BASE_FONT_PX,
    min: 10,
    max: 32,
    step: 1,
    coerce: (value) => {
      // A size, in px, at the root. Named in px rather than as a preset because
      // a preset cannot express "the one in between the two I like".
      //
      // Clamped rather than rejected: a size slightly out of range should still
      // render, and only a nonsense value falls back to the default.
      const number = Number(value);
      if (!Number.isFinite(number)) return BASE_FONT_PX;
      return Math.min(32, Math.max(10, Math.round(number)));
    },
  },
  {
    // WHERE the reading goes, not whether to have one.
    //
    // The four values are the four layouts the mock compared; three of them are
    // real choices rather than degrees of one, which is why this is not a boolean.
    //
    // Defaults to `above` — ruby, the reading over its own word — because that is
    // the layout that keeps every glyph in place. `off` is still available and is
    // the first option, so a reader who does not want it loses nothing.
    id: 'romaji',
    label: 'Reading',
    group: 'reading',
    type: 'select',
    options: READING_OPTIONS,
    // VISIBLE, and it is the one of the three that is. A reading is the feature
    // people asked for; tone style and script conversion are refinements of it.
    default: 'above',
    coerce: (value) => (READING_OPTIONS.some((o) => o.value === value) ? value : 'above'),
  },
  {
    // How a reading is written, not where it goes. Separate from `romaji`
    // because they are independent: tone numbers are a Chinese convention with no
    // Japanese equivalent, and both placements can show either form.
    id: 'toneStyle',
    label: 'Pinyin tones',
    group: 'reading',
    type: 'select',
    options: TONE_OPTIONS,
    hidden: true,
    // Marks, because that is what a dictionary prints and what a learner meets
    // first. Numbers are for typing and searching.
    default: 'marks',
    coerce: (value) => (TONE_OPTIONS.some((o) => o.value === value) ? value : 'marks'),
  },
  {
    // Whether to rewrite Chinese subtitles between scripts.
    //
    // **Wired but not exposed, and I would argue against shipping it.** The
    // dictionary already resolves traditional text — `wordlist.js` maps traditional
    // forms back to simplified keys and includes them as headwords — so unlike a
    // reading, nothing is BROKEN without this. It is purely a display rewrite, and
    // it is lossy in one direction: 髮 and 發 both become 发, 後 and 后 both become
    // 后. Subtitles are the author's text, and quietly rewriting them is a
    // different kind of change from annotating them.
    //
    // Kept settable so the decision can be made with the machinery visible.
    id: 'scriptConversion',
    label: 'Chinese script',
    group: 'reading',
    type: 'select',
    options: SCRIPT_OPTIONS,
    hidden: true,
    default: 'off',
    coerce: (value) => (SCRIPT_OPTIONS.some((o) => o.value === value) ? value : 'off'),
  },
  {
    id: 'listId',
    label: 'Word list',
    group: 'learning',
    type: 'select',
    default: null,
    dynamic: true,
    coerce: (value) => (typeof value === 'string' && value ? value : null),
  },
  {
    id: 'threshold',
    label: 'Highlight from',
    group: 'learning',
    type: 'select',
    // The FIRST level, so everything is marked until the learner narrows it.
    //
    // Deliberately not a per-list "sensible default": the right starting point
    // depends on the person, and the only thing this app can know about someone
    // it has never met is that they have not chosen yet. It used to be a number
    // carried by the list, and that number was 4 for both HSK lists — the level
    // of whoever built it — so a stranger's first panel opened at somebody
    // else's ability.
    default: 1,
    dynamic: true,
    coerce: (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
    },
  },
  {
    // The threshold last chosen FOR EACH LIST, restored when the learner returns
    // to that list.
    //
    // Per list because a threshold only means something against its own list: 4
    // is "upper intermediate" in a six-level list and something else entirely in
    // a five-level one. So switching list is not "keep my number" (it has
    // changed meaning) and not "reset" (which throws away a choice the learner
    // made) — it is "restore what I chose here, or start at the top if I never
    // chose".
    //
    // A map, and not rendered as a control: it is the memory BEHIND the
    // threshold picker, not something edited directly.
    id: 'listThresholds',
    label: 'Level per list',
    group: 'learning',
    type: 'map',
    default: {},
    dynamic: true,
    coerce: (value) => {
      /** @type {Record<string, number>} */
      const out = {};
      if (!value || typeof value !== 'object') return out;
      for (const [listId, raw] of Object.entries(value)) {
        const number = Number(raw);
        if (Number.isFinite(number) && number >= 1) out[listId] = Math.floor(number);
      }
      return out;
    },
  },
  {
    // NOT on the toolbar, and deliberately so — it is a real setting with no
    // control, which is the shape every setting takes until there are enough of
    // them to deserve a settings page.
    //
    // `hidden: true` is what says so. The panel renders controls explicitly, so an
    // unrendered setting would be invisible by accident rather than by intent, and
    // an accident is indistinguishable from a bug the day someone adds a control
    // loop. This is the flag a future settings sheet filters on.
    //
    // Still a full setting: persisted, coerced and broadcast on state like any
    // other, so exposing it later is a control and nothing else.
    id: 'markStyle',
    label: 'Marks',
    group: 'reading',
    type: 'select',
    options: MARK_STYLE_OPTIONS,
    hidden: true,
    default: 'underline',
    coerce: (value) => (MARK_STYLE_OPTIONS.some((o) => o.value === value) ? value : 'underline'),
  },
  {
    id: 'studyLanguage',
    label: 'Subtitle',
    group: 'language',
    type: 'select',
    default: null,
    dynamic: true,
    coerce: (value) => (typeof value === 'string' && value ? value : null),
  },
  {
    // The gloss: the line that explains the study line. Optional.
    //
    // It may be the SAME language as the study line, and that is not a mistake —
    // it is the only way to ask for "English" with its translation underneath,
    // because a translation needs a source track to convert and "Off" has none.
    // The old model expressed that by putting one language in two slots, which
    // was indistinguishable from having chosen it twice by accident.
    id: 'glossLanguage',
    label: 'Second subtitle',
    group: 'language',
    type: 'select',
    default: null,
    dynamic: true,
    coerce: (value) => (typeof value === 'string' && value ? value : null),
  },
  {
    // YouTube's "auto-translate". Not a separate track: the same track's URL with
    // `&tlang=` added, so cue timings are identical and only the text changes.
    // That is why it composes with alignment and seeking for free.
    //
    // A GLOBAL target rather than one per line. It is a preference — a learner
    // reading Chinese wants English every time — so the choice is made once
    // instead of being a 156-item list attached to each line.
    id: 'translateInto',
    label: 'Translate into',
    group: 'language',
    type: 'select',
    default: null,
    dynamic: true,
    coerce: (value) => (typeof value === 'string' && value ? value : null),
  },
  {
    // Whether a line shows the translation instead of the original. Two bits,
    // one per line, sharing the single target above.
    //
    // BOTH lines can be translated. An earlier version allowed only the second,
    // on the reasoning that the first is "the line being learned". That conflated
    // two separate things — which line carries the learning MARKS, and which line
    // can be TRANSLATED — and made a real feature look like a principle. The
    // cases it broke are ordinary: a Chinese-only video where you want the
    // Chinese line translated with the original kept for reading, or an English
    // video where the first line is the one you want naturalised.
    //
    // The rule that actually holds is about marks, not translation: a machine
    // translation carries no learning marks, because it paraphrases rather than
    // glosses and hides the word boundaries the marks exist to point at. That
    // applies to whichever line is translated.
    id: 'studyTranslated',
    label: 'Translate first',
    group: 'language',
    type: 'toggle',
    default: false,
    coerce: (value) => Boolean(value),
  },
  {
    id: 'glossTranslated',
    label: 'Translate second',
    group: 'language',
    type: 'toggle',
    default: false,
    coerce: (value) => Boolean(value),
  },
];

/** @type {Map<string, SettingDefinition>} */
const BY_ID = new Map(SETTINGS.map((setting) => [setting.id, setting]));

const STORAGE_KEY = 'settings';

/**
 * Every setting at its default, plus anything stored that we still know about.
 *
 * A structured clone of each default rather than the default itself. Object and
 * array defaults are shared by reference, so handing one out means every caller
 * — and every service-worker boot in a test process — receives the SAME object.
 * Writing to it then changes the default for everything that reads it
 * afterwards. That is not hypothetical: it silently carried one test's chosen
 * level into the next worker's settings, and would do the same to a real user
 * whose two contexts shared a module instance.
 *
 * Scalars are unaffected, which is exactly why the bug is easy to miss — it only
 * appears once a setting's default is a collection.
 */
export function defaults() {
  const out = {};
  for (const setting of SETTINGS) {
    out[setting.id] = setting.default && typeof setting.default === 'object'
      ? structuredClone(setting.default)
      : setting.default;
  }
  return out;
}

/** Renamed settings, so a stored choice is not silently lost. */
const RENAMES = {
  primaryLanguage: 'studyLanguage',
  secondaryLanguage: 'glossLanguage',
};

/**
 * Merge stored values over the defaults, coercing each and dropping unknown keys.
 *
 * Dropping unknown keys matters: a setting that was removed should not linger in
 * storage and be re-sent on every save, and a renamed one should not shadow the
 * new definition.
 *
 * @param {object|null|undefined} stored
 * @returns {Record<string, any>}
 */
export function normalise(stored) {
  const out = defaults();
  if (!stored || typeof stored !== 'object') return out;

  // Carry a renamed choice across before reading it, so a learner who had picked
  // a subtitle keeps it. Reading the object rather than writing over storage
  // keeps this pure and re-runnable.
  const source = { ...stored };
  for (const [from, to] of Object.entries(RENAMES)) {
    if (source[to] === undefined && source[from] !== undefined) source[to] = source[from];
  }

  // The two per-line translation targets collapse into one preference plus one
  // bit. If either slot was being translated, the target becomes the gloss's —
  // which is where a translation can live now — and the gloss is switched on so
  // the choice is not lost.
  if (source.translateInto === undefined) {
    const target = source.translateSecondary ?? source.translatePrimary;
    if (target) source.translateInto = target;
    if (source.glossTranslated === undefined && source.translateSecondary) {
      source.glossTranslated = true;
    }
  }

  for (const [id, value] of Object.entries(source)) {
    const setting = BY_ID.get(id);
    if (!setting) continue; // no longer a setting
    out[id] = setting.coerce ? setting.coerce(value) : value;
  }
  return out;
}

/** @param {object} settings @returns {object} */
export function toStorage(settings) {
  return { [STORAGE_KEY]: normalise(settings) };
}

export const storageKey = STORAGE_KEY;

/**
 * @param {string} id
 * @returns {SettingDefinition|undefined}
 */
export function definition(id) {
  return BY_ID.get(id);
}

/** @param {string} [group] @returns {SettingDefinition[]} */
export function byGroup(group) {
  return group ? SETTINGS.filter((setting) => setting.group === group) : SETTINGS;
}
