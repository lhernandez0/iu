/**
 * Boots the side panel against DOM and chrome stubs.
 *
 * This file exists because of a real bug: the panel called
 * `chrome.runtime.connect` once, at module scope, and had no recovery path.
 * When the worker was not there, the connection failed silently, Chrome logged
 * "Unchecked runtime.lastError: Could not establish connection. Receiving end
 * does not exist", and the panel sat on its placeholder forever. None of that is
 * visible to a static check, so the module has to actually run.
 *
 * Run with `npm test`.
 */

import { installDomStub, installChromeStubForPanel } from './dom-stub.mjs';

let failures = 0;
let checks = 0;
let bootCount = 0;

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The ids sidepanel.html actually declares. */
const PANEL_IDS = [
  'primary',
  'secondary',
  'translate-primary',
  'translate-secondary',
  'translate-menu',
  'translate-toggle-primary',
  'translate-toggle-secondary',
  'swap',
  'view-mode',
  'font-size',
  'list',
  'threshold',
  'follow',
  'status',
  'transcript',
  'copy',
  'format',
  'save',
];

/** Ids the real sidepanel.html starts hidden. */
const HIDDEN_IDS = ['translate-menu'];

/**
 * Evaluate a fresh copy of the panel against fresh stubs.
 *
 * @param {{failWith?: string}} [options]
 * @returns {Promise<{ports: object[], lastPort: Function, lastErrorRead: Function, created: object[], byId: Map<string, object>, dom: object}>}
 */
async function bootPanel(options = {}) {
  const dom = installDomStub(PANEL_IDS, { hidden: HIDDEN_IDS });
  const chromeStub = installChromeStubForPanel(options);
  await import(`../src/sidepanel/sidepanel.js?boot=${++bootCount}`);
  await settle();
  return { ...chromeStub, ...dom, dom };
}

/** @param {object} fakeElement */
const textOf = (fakeElement) => fakeElement?.textContent ?? '';

/**
 * A complete STATE payload, with the learning settings overridden.
 *
 * The panel renders the settings controls from this, so a test that only wants
 * to exercise the view or the text size still has to send a state the panel can
 * render — a partial one would throw while rendering the rest of the bar and the
 * failure would look like the feature under test.
 *
 * @param {object} [learning]  Overrides for the `learning` block.
 * @param {object} [top]       Overrides for the top level, e.g. `secondary`.
 */
const stateWithSettings = (learning, top) => ({
  videoId: 'abc',
  title: 'Test Video',
  isLive: false,
  trackList: [
    { languageCode: 'en', name: 'English', kind: null, isTranslatable: true },
    { languageCode: 'de', name: 'Deutsch', kind: null, isTranslatable: false },
  ],
  primary: 'en',
  secondary: null,
  // The translate menu is per video, and `translationAvailable` says which
  // tracks can actually take one. `de` is deliberately not translatable, which
  // is the common real case for a human-authored track.
  translationLanguages: [
    { languageCode: 'en', name: 'English' },
    { languageCode: 'ja', name: 'Japanese' },
    { languageCode: 'ko', name: 'Korean' },
  ],
  translationAvailable: { en: true, de: false },
  translatePrimary: null,
  translateSecondary: null,
  rows: [
    { start: 0, duration: 2, text: 'Hey there', secondary: '' },
    { start: 2, duration: 2, text: 'how are you', secondary: '' },
    { start: 4, duration: 2, text: 'welcome back', secondary: '' },
  ],
  error: null,
  ...(top ?? {}),
  learning: {
    view: 'all',
    fontSize: 13,
    listId: 'hsk3_0',
    threshold: 3,
    primaryLanguage: 'en',
    secondaryLanguage: null,
    listOptions: [{ value: 'hsk2_0', label: 'HSK 2.0' }, { value: 'hsk3_0', label: 'HSK 3.0' }],
    thresholdOptions: [{ value: 1, label: '1+' }, { value: 2, label: '2+' }, { value: 3, label: '3+' }],
    ...(learning ?? {}),
  },
});

// --- 1. Boots and connects ---------------------------------------------------

section('panel boots and opens a port to the worker');

{
  const { ports, lastPort } = await bootPanel();

  check('exactly one port opened', ports.length, 1);
  check('named "panel"', ports[0]?.name, 'panel');
  check('nothing sent yet (worker refreshes on connect)', lastPort()?.sent, []);
}

// --- 2. The bug that was reported -------------------------------------------

section('a failed connection is reported, not left hanging or logged by Chrome');

{
  const { ports, byId } = await bootPanel({ failWith: 'Extension context invalidated.' });

  check('no port was established', ports.length, 0);
  const status = textOf(byId.get('status'));
  check('the status explains it', status.includes('out of date'), true);
  check('and says what to do', status.includes('Close and reopen'), true);
  check('it is flagged as an error', byId.get('status').classList.contains('error'), true);
}

// --- 3. A dropped worker reconnects -----------------------------------------

section('losing the worker reconnects instead of giving up');

{
  const { ports, lastPort, byId } = await bootPanel();

  check('one port to start', ports.length, 1);

  lastPort().drop('the worker stopped');
  // Backoff starts at 500ms; wait past it.
  await new Promise((resolve) => setTimeout(resolve, 700));

  check('a second port was opened', ports.length, 2);
  check('the panel said it was reconnecting', textOf(byId.get('status')).includes('Reconnecting'), true);
}

// --- 4. lastError is read ---------------------------------------------------

section('the disconnect reason is read, which is what silences Chrome');

{
  const { lastPort, lastErrorRead } = await bootPanel();

  check('lastError untouched before disconnect', lastErrorRead(), false);
  lastPort().drop('the worker stopped');
  check('lastError was read', lastErrorRead(), true);
}

// --- 5. Rendering ------------------------------------------------------------

section('STATE renders rows, and the spoken line highlights');

{
  const { lastPort, byId } = await bootPanel();
  const port = lastPort();

  port.emit({
    type: 'state',
    state: {
      videoId: 'abc',
      title: 'Test Video',
      isLive: false,
      trackList: [
        { languageCode: 'en', name: 'English', kind: null },
        { languageCode: 'de', name: 'Deutsch', kind: null },
      ],
      primary: 'en',
      secondary: null,
      rows: [
        { start: 0, duration: 2, text: 'Hey there', secondary: '' },
        { start: 2, duration: 2, text: 'how are you', secondary: '' },
        { start: 4, duration: 2, text: 'welcome back', secondary: '' },
      ],
      error: null,
    },
  });

  check('status reports the line count', textOf(byId.get('status')).includes('3 lines'), true);
  // The readable name rather than the code: a status line is for reading, and
  // "en" is a schema value leaking into the UI.
  check('status names the language', textOf(byId.get('status')).includes('English'), true);
  check('status still names the video', textOf(byId.get('status')).includes('Test Video'), true);

  const rows = byId.get('transcript').find((el) => el.classList.contains('row'));
  check('one element per row', rows.length, 3);
  check('row text rendered', rows[0].children.some((c) => textOf(c) === 'Hey there') || textOf(rows[0]).includes('Hey there'), true);

  port.emit({ type: 'position', index: 1, seconds: 2.5 });
  check('the spoken row is highlighted', rows[1].classList.contains('active'), true);
  check('and the others are not', rows[0].classList.contains('active'), false);

  port.emit({ type: 'position', index: 2, seconds: 4.5 });
  check('highlight moves', rows[1].classList.contains('active'), false);
  check('to the new row', rows[2].classList.contains('active'), true);
}

// --- 6. Errors surface ------------------------------------------------------

section('worker errors are shown as errors');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'error', error: 'This video has no captions.' });

  check('message shown verbatim', textOf(byId.get('status')), 'This video has no captions.');
  check('flagged as an error', byId.get('status').classList.contains('error'), true);
}

// --- 7. Intents -------------------------------------------------------------

section('user actions become intents on the port');

{
  const { lastPort, byId } = await bootPanel();
  const port = lastPort();

  byId.get('primary').value = 'de';
  byId.get('primary').dispatch('change');
  check('selecting a primary language sends SET_PRIMARY', port.sent.at(-1)?.type, 'set-primary');
  check('with the chosen language', port.sent.at(-1)?.languageCode, 'de');

  byId.get('secondary').value = 'en';
  byId.get('secondary').dispatch('change');
  check('selecting a second sends SET_SECONDARY', port.sent.at(-1)?.type, 'set-secondary');

  byId.get('follow').checked = false;
  byId.get('follow').dispatch('change');
  check('toggling Follow sends nothing', port.sent.some((m) => m.type === 'follow'), false);
}

// --- 8. Swap -----------------------------------------------------------------

section('swap exchanges the two languages');

{
  const { lastPort, byId } = await bootPanel();
  const port = lastPort();

  byId.get('primary').value = 'en';
  byId.get('secondary').value = 'de';
  byId.get('swap').dispatch('click');

  const types = port.sent.map((m) => m.type);
  check('adjusts the primary', types.includes('set-primary'), true);
  check('adjusts the secondary', types.includes('set-secondary'), true);
  check('primary becomes the old secondary', port.sent.find((m) => m.type === 'set-primary')?.languageCode, 'de');
  check('secondary becomes the old primary', port.sent.find((m) => m.type === 'set-secondary')?.languageCode, 'en');
}

// --- 9. Bad state ------------------------------------------------------------

section('a malformed state is reported rather than silently ignored');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: null });

  check('an error is shown', byId.get('status').classList.contains('error'), true);
  check('with something readable', textOf(byId.get('status')).length > 0, true);
}

// --- 10. The focus view ------------------------------------------------------

section('the focus view is a class on the list, so nothing has to be re-rendered');

{
  const { lastPort, byId, dom } = await bootPanel();
  const port = lastPort();
  const transcript = byId.get('transcript');

  port.emit({ type: 'state', state: stateWithSettings({ view: 'all' }) });
  check('all-lines view is not focus', transcript.classList.contains('focus'), false);

  port.emit({ type: 'state', state: stateWithSettings({ view: 'focus' }) });
  check('focus view sets the class', transcript.classList.contains('focus'), true);

  // The rows are filtered by CSS, so the outline of the panel never changes.
  // Re-rendering instead would drop the marks and the hover listeners with it.
  const rows = transcript.find((el) => el.classList.contains('row'));
  check('the rows are still all there', rows.length, 3);

  port.emit({ type: 'state', state: stateWithSettings({ view: 'all' }) });
  check('and switching back clears it', transcript.classList.contains('focus'), false);
  check('the text size is untouched by the view', dom.document.documentElement.style.getPropertyValue('--font-size'), '13px');
}

section('the line after the current one is marked as the preview');

{
  const { lastPort, byId } = await bootPanel();
  const port = lastPort();
  port.emit({ type: 'state', state: stateWithSettings() });

  const rows = byId.get('transcript').find((el) => el.classList.contains('row'));

  port.emit({ type: 'position', index: 0, seconds: 0.5 });
  check('the successor is the preview', rows[1].classList.contains('next'), true);

  port.emit({ type: 'position', index: 1, seconds: 2.5 });
  // Without clearing the old one, every line ever visited would stay dimmed.
  check('the old preview is cleared', rows[1].classList.contains('next'), false);
  check('and the new successor is it', rows[2].classList.contains('next'), true);
  check('the current line is not also the preview', rows[1].classList.contains('active') && rows[1].classList.contains('next'), false);

  port.emit({ type: 'position', index: 2, seconds: 4.5 });
  check('the last line has no successor to mark', rows[2].classList.contains('next'), false);
}

// --- 11. Text size -----------------------------------------------------------

section('text size is a pixel number applied to the document root');

{
  const { lastPort, dom, byId } = await bootPanel();

  lastPort().emit({ type: 'state', state: stateWithSettings({ fontSize: 13 }) });
  check('13px is applied as 13px', dom.document.documentElement.style.getPropertyValue('--font-size'), '13px');

  lastPort().emit({ type: 'state', state: stateWithSettings({ fontSize: 18 }) });
  // The number the learner picks is the number that lands. A multiplier would
  // need them to know the base size to predict what 1.4 does.
  check('18px is applied as 18px', dom.document.documentElement.style.getPropertyValue('--font-size'), '18px');
  check('and the field shows it', byId.get('font-size').value, '18');

  // Sent to the worker too, so the choice survives closing the panel.
  const port = lastPort();
  byId.get('font-size').value = '22';
  byId.get('font-size').dispatch('change');
  check('changing it sends SET_SETTING', port.sent.at(-1)?.type, 'set-setting');
  check('for the fontSize setting', port.sent.at(-1)?.id, 'fontSize');
  check('with a number, not a string', port.sent.at(-1)?.value, 22);
  check('and applies immediately, without waiting for the worker', dom.document.documentElement.style.getPropertyValue('--font-size'), '22px');
}

section('a nonsense text size cannot reach the stylesheet');

{
  const { lastPort, dom, byId } = await bootPanel();

  // Clamped on the panel side as well as in the worker, so a value typed by hand
  // or restored from old storage cannot produce unreadable text.
  lastPort().emit({ type: 'state', state: stateWithSettings({ fontSize: 400 }) });
  check('an absurd size is clamped high', dom.document.documentElement.style.getPropertyValue('--font-size'), '32px');

  lastPort().emit({ type: 'state', state: stateWithSettings({ fontSize: 1 }) });
  check('and low', dom.document.documentElement.style.getPropertyValue('--font-size'), '10px');

  lastPort().emit({ type: 'state', state: stateWithSettings({ fontSize: undefined }) });
  check('a missing size falls back to the base', dom.document.documentElement.style.getPropertyValue('--font-size'), '13px');

  // The control itself carries the range, taken from the schema, so it cannot
  // offer a size the worker would clamp away.
  check('the input knows its minimum', byId.get('font-size').min, '10');
  check('and its maximum', byId.get('font-size').max, '32');
}

section('a half-typed size does not fight the person typing it');

{
  const { lastPort, dom, byId } = await bootPanel();
  const field = byId.get('font-size');
  lastPort().emit({ type: 'state', state: stateWithSettings({ fontSize: 18 }) });

  // Typing "18" passes through "1". Applying that mid-keystroke clamped the size
  // to 10 and re-rendered the whole transcript while the key was still down.
  field.value = '1';
  field.dispatch('input');
  check('a one-digit prefix is not applied', dom.document.documentElement.style.getPropertyValue('--font-size'), '18px');

  field.value = '18';
  field.dispatch('input');
  check('the finished value is applied live', dom.document.documentElement.style.getPropertyValue('--font-size'), '18px');

  field.value = '';
  field.dispatch('input');
  check('an empty field is not a size', dom.document.documentElement.style.getPropertyValue('--font-size'), '18px');

  field.value = '999';
  field.dispatch('input');
  check('an out-of-range value is not applied live', dom.document.documentElement.style.getPropertyValue('--font-size'), '18px');

  // Committing, however, must not leave a value on screen that was not accepted.
  field.value = '999';
  field.dispatch('change');
  check('committing clamps the stylesheet', dom.document.documentElement.style.getPropertyValue('--font-size'), '32px');
  check('and rewrites the field to match', field.value, '32');

  field.value = '';
  field.dispatch('change');
  check('an empty field falls back on commit', dom.document.documentElement.style.getPropertyValue('--font-size'), '13px');
  check('and the field shows the fallback', field.value, '13');
}

section('the view sends its change too, and applies at once');

{
  const { lastPort, byId } = await bootPanel();
  const port = lastPort();

  byId.get('view-mode').value = 'focus';
  byId.get('view-mode').dispatch('change');

  check('SET_SETTING was sent', port.sent.at(-1)?.type, 'set-setting');
  check('for the view', port.sent.at(-1)?.id, 'view');
  check('with the mode', port.sent.at(-1)?.value, 'focus');
  check('and the class is already on', byId.get('transcript').classList.contains('focus'), true);
}

section('the controls are built from the schema, not hand-written here');

{
  const { lastPort, byId } = await bootPanel();
  // The controls are populated from a state, so one has to arrive first.
  lastPort().emit({ type: 'state', state: stateWithSettings() });

  const viewOptions = byId.get('view-mode').find((el) => el.tagName === 'OPTION');

  check('the view offers both modes', viewOptions.length, 2);
  check('named as the schema names them', viewOptions.map((o) => o.text), ['Full', 'Live']);
  check('with the schema values', viewOptions.map((o) => o.value), ['all', 'focus']);
}

// --- 12. Auto-translate ------------------------------------------------------

section('the translate picker offers the video languages, minus the source');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings() });

  const options = byId.get('translate-primary').find((el) => el.tagName === 'OPTION');
  // The first entry is "Original", which is what makes a translation reversible.
  // The source language is excluded from the rest: translating English into
  // English does nothing, and offering it would be a menu entry with no effect.
  check('the first option undoes the translation', options.map((o) => o.value), ['', 'ja', 'ko']);
  check('with readable names', options.map((o) => o.text), ['Original', 'Japanese', 'Korean']);
  check('the source language is not among them', options.map((o) => o.value).includes('en'), false);
  check('the picker is enabled', byId.get('translate-primary').disabled, false);
}

section('a track that cannot be translated disables its picker, with a reason');

{
  const { lastPort, byId } = await bootPanel();
  // YouTube offers a translate menu for a human-authored track too, but applying
  // it returns the ORIGINAL text. Offering it would look like it worked.
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { secondary: 'de' }) });

  const options = byId.get('translate-secondary').find((el) => el.tagName === 'OPTION');
  check('nothing is offered for it', options.map((o) => o.text), ['Original']);
  check('and the picker is disabled', byId.get('translate-secondary').disabled, true);
  check('the title explains why', byId.get('translate-secondary').title, 'This track cannot be auto-translated');
}

section('a translatable second track is offered normally');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { secondary: 'de', translationAvailable: { en: true, de: true } }) });

  const options = byId.get('translate-secondary').find((el) => el.tagName === 'OPTION');
  check('the languages are offered', options.map((o) => o.value), ['', 'en', 'ja', 'ko']);
  check('and it is enabled', byId.get('translate-secondary').disabled, false);
}

section('no second subtitle means no translate picker for it');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { secondary: null }) });

  check('it is disabled', byId.get('translate-secondary').disabled, true);
  check('with an explanation', byId.get('translate-secondary').title, 'No subtitle selected');
}

section('choosing a translation asks the worker for it');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings() });
  const port = lastPort();

  byId.get('translate-primary').value = 'ja';
  byId.get('translate-primary').dispatch('change');

  check('SET_SETTING was sent', port.sent.at(-1)?.type, 'set-setting');
  check('for the primary translation', port.sent.at(-1)?.id, 'translatePrimary');
  check('with the target language', port.sent.at(-1)?.value, 'ja');
}

section('choosing the original sends an explicit null, not an empty string');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { translatePrimary: 'ja' }) });
  const port = lastPort();

  // "Original" has to be ACHIEVABLE. An earlier version used it only as the
  // placeholder shown when the list was empty, which meant a translation could
  // be chosen and then never undone.
  check('translated to start', byId.get('translate-primary').value, 'ja');

  byId.get('translate-primary').value = '';
  byId.get('translate-primary').dispatch('change');

  // null means "the original text", which is different from "no preference" —
  // the setting has to be explicitly cleared or the worker would keep asking.
  check('null is sent', port.sent.at(-1)?.value, null);
  check('for the right setting', port.sent.at(-1)?.id, 'translatePrimary');
}

section('a translated line is tagged as machine output');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { translatePrimary: 'ja' }) });

  const tags = byId.get('transcript').find((el) => el.classList.contains('machine'));
  // Machine translation of Chinese paraphrases rather than glosses, so a
  // translated line should not read as a human translation of what was said.
  check('the row is tagged', tags.length > 0, true);
  check('with MT', tags[0]?.textContent, 'MT');
  check('and the target is named on hover', String(tags[0]?.title ?? '').includes('Japanese'), true);
}

section('an untranslated line carries no tag');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings() });

  const tags = byId.get('transcript').find((el) => el.classList.contains('machine'));
  check('nothing is tagged', tags.length, 0);
}

section('swapping languages carries each translation with its slot');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({
    type: 'state',
    state: stateWithSettings(null, { secondary: 'de', translatePrimary: 'ja', translateSecondary: 'ko', translationAvailable: { en: true, de: true } }),
  });
  const port = lastPort();

  byId.get('swap').dispatch('click');

  const set = (id) => port.sent.find((m) => m.type === 'set-setting' && m.id === id)?.value;
  // Leaving them behind would apply the primary's target to whatever language
  // ended up in that slot — the wrong translation, with nothing to show it.
  check('the primary slot takes the old secondary translation', set('translatePrimary'), 'ko');
  check('and the secondary slot the old primary one', set('translateSecondary'), 'ja');
}

section('the status line distinguishes a translation from a real track');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { translatePrimary: 'ja' }) });

  const status = textOf(byId.get('status'));
  // An arrow, because "English" on its own would claim a Japanese track exists
  // when it is English text machine-translated into Japanese.
  check('the translation is shown', status.includes('English→Japanese'), true);
}

// --- 13. The translate menu behind an icon -----------------------------------

section('the translate menus stay out of the way until asked for');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings() });

  // Four stacked pickers made the bar taller and put a dead control on screen
  // whenever the video had no second subtitle. One icon reveals both menus.
  check('the menu starts hidden', byId.get('translate-menu').hidden, true);

  byId.get('translate-toggle-primary').dispatch('click');
  check('clicking the icon reveals it', byId.get('translate-menu').hidden, false);
  check('and the icon reports it is expanded', byId.get('translate-toggle-primary').getAttribute('aria-expanded'), 'true');
  check('and is marked active', byId.get('translate-toggle-primary').classList.contains('on'), true);

  // The second icon opens the same menu: they are different settings but the
  // same act, so one state to understand rather than two.
  byId.get('translate-toggle-secondary').dispatch('click');
  check('either icon closes it again', byId.get('translate-menu').hidden, true);
  check('and clears the active mark', byId.get('translate-toggle-primary').classList.contains('on'), false);
}

section('the paused line holds its place in both views');

{
  const { lastPort, byId } = await bootPanel();
  const port = lastPort();
  port.emit({ type: 'state', state: stateWithSettings() });
  const rows = byId.get('transcript').find((el) => el.classList.contains('row'));

  // In a gap: the line that finished is still the current line, but nothing is
  // being said. It dims rather than vanishing.
  port.emit({ type: 'position', index: 1, seconds: 3, paused: true });
  check('the row keeps the highlight', rows[1].classList.contains('active'), true);
  check('and is marked as not speaking', rows[1].classList.contains('paused'), true);

  port.emit({ type: 'position', index: 2, seconds: 4.5, paused: false });
  check('speaking clears the dim', rows[2].classList.contains('paused'), false);
  check('including on the row that had it', rows[1].classList.contains('paused'), false);
  check('and the highlight moved on', rows[2].classList.contains('active'), true);
}

section('a state push carries the paused flag, so a panel opened mid-gap agrees');

{
  const { lastPort, byId } = await bootPanel();
  // The flag has to travel in state as well as in the position event, or a panel
  // opened during a gap would show a line as though it were being spoken.
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { activeIndex: 0, activePaused: true }) });

  const rows = byId.get('transcript').find((el) => el.classList.contains('row'));
  check('the row is highlighted', rows[0].classList.contains('active'), true);
  check('and dimmed, because it is a gap', rows[0].classList.contains('paused'), true);
}

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
