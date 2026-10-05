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
 * @property {'select'|'number'} type
 * @property {any} default
 * @property {Array<{value: any, label: string}>} [options] For 'select'.
 * @property {string} [group]       Which section of the panel it belongs to.
 * @property {(value: any, context?: object) => any} [coerce] Normalise a stored value.
 * @property {boolean} [dynamic]    Options are supplied at render time, not here.
 */

/** A reader's eye needs a range wider than Latin text suggests: CJK is denser per character. */
const TEXT_SCALE_OPTIONS = [
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Normal' },
  { value: 1.2, label: 'Large' },
  { value: 1.45, label: 'Larger' },
  { value: 1.75, label: 'Huge' },
];

/** How much of the transcript is shown at once. */
const VIEW_OPTIONS = [
  { value: 'all', label: 'All lines' },
  { value: 'focus', label: 'Current + next' },
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
    id: 'textScale',
    label: 'Text size',
    group: 'reading',
    type: 'select',
    options: TEXT_SCALE_OPTIONS,
    default: 1,
    coerce: (value) => {
      const number = Number(value);
      // Clamped rather than rejected: a size slightly out of range should still
      // render, and only a nonsense value falls back to the default.
      if (!Number.isFinite(number) || number <= 0) return 1;
      return Math.min(3, Math.max(0.5, number));
    },
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
    default: null,
    dynamic: true,
    coerce: (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
    },
  },
  {
    id: 'primaryLanguage',
    label: 'Subtitle',
    group: 'language',
    type: 'select',
    default: null,
    dynamic: true,
    coerce: (value) => (typeof value === 'string' && value ? value : null),
  },
  {
    id: 'secondaryLanguage',
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
    id: 'translatePrimary',
    label: 'Translate',
    group: 'language',
    type: 'select',
    default: null,
    dynamic: true,
    coerce: (value) => (typeof value === 'string' && value ? value : null),
  },
  {
    id: 'translateSecondary',
    label: 'Translate second',
    group: 'language',
    type: 'select',
    default: null,
    dynamic: true,
    coerce: (value) => (typeof value === 'string' && value ? value : null),
  },
];

/** @type {Map<string, SettingDefinition>} */
const BY_ID = new Map(SETTINGS.map((setting) => [setting.id, setting]));

const STORAGE_KEY = 'settings';

/** Every setting at its default, plus anything stored that we still know about. */
export function defaults() {
  const out = {};
  for (const setting of SETTINGS) out[setting.id] = setting.default;
  return out;
}

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

  for (const [id, value] of Object.entries(stored)) {
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
