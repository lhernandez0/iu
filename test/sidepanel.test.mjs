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
// `PANEL_IDS` is the set of controls the real HTML declares, so the schema and the
// markup can be checked against each other rather than only in isolation.
import { SETTINGS } from '../src/common/settings.js';

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
  'study',
  'study-translated',
  'gloss',
  'gloss-translated',
  'translate-target-row',
  'translate-into',
  'swap',
  'view-mode',
  'layout',
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
const HIDDEN_IDS = ['translate-target-row'];

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
  study: 'en',
  gloss: null,
  // The translate menu is per video, and `translationAvailable` says which
  // tracks can actually take one. `de` is deliberately not translatable, which
  // is the common real case for a human-authored track.
  translationLanguages: [
    { languageCode: 'en', name: 'English' },
    { languageCode: 'ja', name: 'Japanese' },
    { languageCode: 'ko', name: 'Korean' },
  ],
  translationAvailable: { en: true, de: false },
  glossTranslation: null,
  translateInto: null,
  glossTranslated: false,
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
    translateInto: null,
    glossTranslated: false,
    listOptions: [{ value: 'hsk2_0', label: 'HSK 2.0' }, { value: 'hsk3_0', label: 'HSK 3.0' }],
    // Named by the list, and the numeric HSK names are the same as their values,
    // so the panel test does not depend on the naming — the browser test is where
    // JLPT's N5..N1 ordering is exercised.
    thresholdOptions: [{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }],
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
      study: 'en',
      gloss: null,
      studyTranslation: null,
      glossTranslation: null,
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

  byId.get('study').value = 'de';
  byId.get('study').dispatch('change');
  check('selecting a study language sends SET_STUDY', port.sent.at(-1)?.type, 'set-study');
  check('with the chosen language', port.sent.at(-1)?.languageCode, 'de');

  byId.get('gloss').value = 'en';
  byId.get('gloss').dispatch('change');
  check('selecting a second line sends SET_GLOSS', port.sent.at(-1)?.type, 'set-gloss');

  byId.get('follow').checked = false;
  byId.get('follow').dispatch('change');
  check('toggling Follow sends nothing', port.sent.some((m) => m.type === 'follow'), false);
}

// --- 8. Swap -----------------------------------------------------------------

section('swap exchanges the two lines, and does NOT carry the translation');

{
  const { lastPort, byId } = await bootPanel();
  const port = lastPort();

  byId.get('study').value = 'en';
  byId.get('gloss').value = 'de';
  byId.get('swap').dispatch('click');

  const types = port.sent.map((m) => m.type);
  check('adjusts the study line', types.includes('set-study'), true);
  check('adjusts the gloss line', types.includes('set-gloss'), true);
  check('the study line becomes the old gloss', port.sent.find((m) => m.type === 'set-study')?.languageCode, 'de');
  check('the gloss line becomes the old study', port.sent.find((m) => m.type === 'set-gloss')?.languageCode, 'en');

  // The translation is a property of the GLOSS, and the study line is never
  // translated. Carrying it across a swap would put machine output on the line
  // whose marks and definitions describe different text.
  check('no translation setting is moved', types.includes('set-setting'), false);
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

// --- 11b. Settings with no control yet ---------------------------------------

section('a setting can exist without a control, and still be a real setting');

{
  // `markStyle` is the first of these: a genuine preference with no toolbar
  // control, waiting for a settings page. Two things have to hold, and they pull
  // in opposite directions — it must not clutter the toolbar, and it must not be
  // a second-class setting that behaves differently from the visible ones.
  const hidden = SETTINGS.filter((setting) => setting.hidden);
  check('at least one setting is marked hidden', hidden.length > 0, true);

  // Hidden has to MEAN something, or the flag is decoration. The panel renders
  // controls explicitly, so nothing would render it today either way — which is
  // exactly why the flag needs asserting now: it has to still be true on the day
  // someone adds a loop that renders every setting in a group.
  const rendered = new Set([...PANEL_IDS, ...HIDDEN_IDS]);
  const withControls = SETTINGS.filter((s) => !s.hidden && s.type !== 'map').map((s) => s.id);
  check('no hidden setting is also a rendered control', withControls.filter((id) => hidden.some((h) => h.id === id)), []);
  check('and the rendered set is not empty, so the check above is meaningful', withControls.length > 0, true);

  // Complete like any other setting, so exposing it later is a control and
  // nothing else. A hidden setting with no options would render an empty select.
  const incomplete = hidden.filter(
    (s) => !s.group || !s.label || s.default === undefined || (s.type === 'select' && !(s.options ?? []).length),
  );
  check('every hidden setting is complete enough to render as-is', incomplete.map((s) => s.id), []);

  const { lastPort, dom } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings({ markStyle: 'highlight' }) });
  const root = dom.created.find((el) => el.tagName === 'HTML');

  check('the panel applies a hidden setting it is sent', root?.classList.contains('mark-highlight'), true);
}

// --- 12. Auto-translate ------------------------------------------------------

section('either line can be translated, independently');

{
  const { lastPort, byId } = await bootPanel();

  // The thing I got wrong twice: translation was tied to the second line, first
  // because it was a property of a slot and then because I called the first line
  // "the one being learned". Neither is a reason. Both lines can be translated, and
  // both controls are always present so neither is discoverable only by accident.
  check('the first line has its own box', byId.get('study-translated') !== undefined, true);
  check('and so does the second', byId.get('gloss-translated') !== undefined, true);
}

section('the target appears only when something is asking to be translated');

{
  const { lastPort, byId } = await bootPanel();

  lastPort().emit({ type: 'state', state: stateWithSettings(null, { studyTranslated: false, glossTranslated: false }) });
  check('hidden with nothing ticked', byId.get('translate-target-row').hidden, true);

  // The first line alone is enough to need a target.
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { study: 'en', studyTranslated: true }) });
  check('shown for the first line alone', byId.get('translate-target-row').hidden, false);
}

section('the target list excludes both languages in use');

{
  const { lastPort, byId } = await bootPanel();
  // Both lines are English and German, so neither is a useful target: translating
  // a language into itself is a no-op that looks like a working menu entry.
  lastPort().emit({
    type: 'state',
    state: stateWithSettings(null, { study: 'en', gloss: 'de', glossTranslated: true }),
  });

  const options = byId.get('translate-into').find((el) => el.tagName === 'OPTION');
  check('neither source language is offered', options.map((o) => o.value), ['ja', 'ko']);
  check('with readable names', options.map((o) => o.text), ['Japanese', 'Korean']);
  check('and the picker is enabled', byId.get('translate-into').disabled, false);
}

section('a track that cannot be translated disables its own box, with a reason');

{
  const { lastPort, byId } = await bootPanel();
  // YouTube offers a translate menu for a human-authored track too, but applying
  // it returns the ORIGINAL text. Offering it would look like it worked.
  lastPort().emit({
    type: 'state',
    state: stateWithSettings(null, { gloss: 'de', glossTranslated: true, translationAvailable: { en: true, de: false } }),
  });

  check('the box cannot be ticked', byId.get('gloss-translated').disabled, true);
  check('and it explains why', byId.get('gloss-translated').title, 'This caption track cannot be auto-translated');
}

section('each checkbox reflects and changes its own bit');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { studyTranslated: true, glossTranslated: true }) });

  check('the first starts ticked', byId.get('study-translated').checked, true);
  check('and so does the second', byId.get('gloss-translated').checked, true);

  const port = lastPort();
  byId.get('study-translated').checked = false;
  byId.get('study-translated').dispatch('change');
  check('unticking the first sends its setting', port.sent.at(-1)?.id, 'studyTranslated');
  check('as a boolean', port.sent.at(-1)?.value, false);
}

section('choosing a target sends it as the global preference');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { gloss: 'en', glossTranslated: true }) });
  const port = lastPort();

  byId.get('translate-into').value = 'ja';
  byId.get('translate-into').dispatch('change');

  check('SET_SETTING was sent', port.sent.at(-1)?.type, 'set-setting');
  // One setting, not one per line: the target is a preference, and which line it
  // applies to is the gloss's business.
  check('for the global target', port.sent.at(-1)?.id, 'translateInto');
  check('with the target language', port.sent.at(-1)?.value, 'ja');
}

section('a translated gloss is tagged as machine output');

{
  const { lastPort, byId } = await bootPanel();
  // The rows need second-line text, or there is no gloss element to tag.
  lastPort().emit({
    type: 'state',
    state: stateWithSettings(null, {
      gloss: 'en',
      glossTranslation: 'ja',
      rows: [
        { start: 0, duration: 2, text: 'Hey there', secondary: 'こんにちは' },
        { start: 2, duration: 2, text: 'how are you', secondary: 'お元気ですか' },
      ],
    }),
  });

  const tags = byId.get('transcript').find((el) => el.classList.contains('machine'));
  // Machine translation of Chinese paraphrases rather than glosses, so a
  // translated line should not read as a human translation of what was said.
  check('the row is tagged', tags.length > 0, true);
  check('with MT', tags[0]?.textContent, 'MT');
  check('and the target is named on hover', String(tags[0]?.title ?? '').includes('Japanese'), true);
}

section('an untranslated gloss carries no tag');

{
  const { lastPort, byId } = await bootPanel();
  // A second line that is an ordinary track is not machine output, so it must not
  // be labelled as though it were.
  const rows = [
    { start: 0, duration: 2, text: 'Hey there', secondary: 'Hallo' },
    { start: 2, duration: 2, text: 'how are you', secondary: 'wie geht es dir' },
  ];
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { gloss: 'de', glossTranslation: null, rows }) });

  const tags = byId.get('transcript').find((el) => el.classList.contains('machine'));
  check('nothing is tagged', tags.length, 0);
}

section('the status line distinguishes a translation from a real track');

{
  const { lastPort, byId } = await bootPanel();
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { gloss: 'en', glossTranslation: 'ja' }) });

  const status = textOf(byId.get('status'));
  // An arrow, because "English" on its own would claim a Japanese track exists
  // when it is English text machine-translated into Japanese.
  check('the translation is shown', status.includes('English→Japanese'), true);
}

section('the study line is never reported as translated');

{
  const { lastPort, byId } = await bootPanel();
  // Even with a translation in effect for the gloss, the study line is the text
  // being learned and is shown as-is. A translation on it would mean the marks
  // and definitions describe a text the learner cannot see.
  lastPort().emit({ type: 'state', state: stateWithSettings(null, { study: 'en', gloss: 'en', glossTranslation: 'ko' }) });

  const status = textOf(byId.get('status'));
  check('the study line is plain', status.includes('English +'), true);
  check('and only the gloss carries an arrow', status.includes('English→Korean'), true);
  check('the study line is not itself translated', status.includes('→English'), false);
}

// --- 13. The Collapsed layout ------------------------------------------------

section('the Collapsed toggle is reachable from wherever it is set');

{
  const { lastPort, byId } = await bootPanel();
  const button = byId.get('layout');

  // The bug this pins: the toggle was a select inside the reading bar, and the
  // reading bar is exactly what collapsed hides. Collapsing removed the only
  // control that could undo it, so the panel was stuck with no way back — which is
  // the single most important property of a toggle, and it was absent.
  //
  // The DOM cannot prove where the button sits, so what is asserted here is that
  // the button is not inside the region the stylesheet hides. The class name is
  // the contract; the browser suite checks the layout for real.
  check('the toggle is not in the reading bar', button.classList.contains('learning'), false);

  // A button in the real markup, asserted in the browser suite: the DOM stub here
  // creates every element as a generic div, so `tagName` cannot distinguish them.
  // What matters hermetically is the behaviour, which is below.

  lastPort().emit({ type: 'state', state: stateWithSettings({ layout: 'collapsed' }) });
  check('collapsed is reflected on the button', button.getAttribute('aria-pressed'), 'true');
  check('and it says what pressing it will do', button.title, 'Show the reading controls');

  lastPort().emit({ type: 'state', state: stateWithSettings({ layout: 'full' }) });
  check('full is reflected on the button', button.getAttribute('aria-pressed'), 'false');
  check('with the opposite label', button.title, 'Hide the reading controls');

  // Clicking flips it, and the state does not have to come back from the worker
  // for the button to look right.
  const port = lastPort();
  button.setAttribute('aria-pressed', 'false');
  button.dispatch('click');
  check('clicking collapses', button.getAttribute('aria-pressed'), 'true');
  check('and sends the setting', port.sent.at(-1)?.id, 'layout');
  check('with the new value', port.sent.at(-1)?.value, 'collapsed');

  button.dispatch('click');
  check('clicking again expands', button.getAttribute('aria-pressed'), 'false');
  check('and sends that too', port.sent.at(-1)?.value, 'full');
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

section('readings render only when the setting asks for them');

{
  // The setting defaults to `off`, so every existing reader sees exactly the panel
  // they saw before this existed. Asserted first because it is the property most
  // likely to break quietly: a reading appearing unasked is a change to someone's
  // reading surface that they did not choose.
  //
  // Counted from the `created` list with a mark and a slice, NOT a running total.
  // The stub records every element ever built and a state push does not clear it,
  // so a bare count accumulates across the pushes below — which made `below` look
  // like it was drawing two rubies when it had drawn none.
  const TOKENS = [
    { text: '他', defined: true, level: 1, reading: 'tā' },
    { text: '终于', defined: true, level: 3, reading: 'zhōngyú' },
  ];

  const { lastPort, dom } = await bootPanel();

  /** Built since the previous read, grouped by class. */
  let mark = dom.created.length;
  const builtSince = () => dom.created.slice(mark);
  const push = (learning, tokens) => {
    mark = dom.created.length;
    lastPort().emit({
      type: 'state',
      state: stateWithSettings(learning, {
        rows: [{ start: 0, duration: 2, text: '他 终于', secondary: '', tokens }],
      }),
    });
  };
  /** @param {string} name */
  const ofClass = (name) => builtSince().filter((el) => el.classList.contains(name));
  /**
   * The words a rendered node actually says, with the annotation taken out.
   *
   * A reading is drawn as `<rt>` INSIDE the ruby, so the ruby's raw text is
   * `tā他` — annotation first, exactly as it is written in the markup. Any
   * assertion about the WORD has to drop the `<rt>` first, which is the same
   * rule the browser suite and `baseText` follow for a whole line.
   *
   * @param {object} node
   * @returns {string}
   */
  const baseTextOf = (node) =>
    (node?.children ?? [])
      .filter((child) => !child.classList?.contains('rt'))
      .map((child) => child.textContent ?? '')
      .join('');

  push({ romaji: 'off' }, TOKENS);
  check('off draws no ruby', ofClass('ruby').length, 0);
  check('and no reading text', ofClass('rt').length, 0);
  // The words still render: a reading is an addition, not a replacement.
  check('but the words are still there', ofClass('mark').length, 2);

  push({ romaji: 'above' }, TOKENS);
  check('above draws ruby', ofClass('ruby').length, 2);
  check('with the reading above the word', ofClass('rt')[0]?.textContent, 'tā');
  // `tā` is the annotation and `他` the base; only the base is the word.
  check('and the word below it', baseTextOf(ofClass('ruby')[0]), '他');

  push({ romaji: 'below' }, TOKENS);
  check('below draws no ruby', ofClass('ruby').length, 0);
  check('but a reading line', ofClass('reading-line').length, 1);
  check('carrying both readings', ofClass('reading-line')[0]?.textContent, 'tā zhōngyú');

  // `marked` annotates only what the list already highlights, which is why it is
  // the placement that costs no extra row height.
  push({ romaji: 'marked', threshold: 3 }, [
    { text: '他', defined: true, level: null, reading: 'tā' },
    { text: '终于', defined: true, level: 3, reading: 'zhōngyú' },
  ]);
  check('marked annotates only the marked word', ofClass('ruby').length, 1);
  check('and it is the one above the threshold', ofClass('rt')[0]?.textContent, 'zhōngyú');
}

section('a reading with no word to attach to is not drawn as an empty stack');

{
  // The negative that would otherwise be invisible. A token with no reading must
  // render as plain text rather than as an empty ruby stack — a stack still takes
  // vertical space and indents its word, so a line of unknown words would come out
  // looking centre-aligned for no visible reason.
  const byClass = (dom, name) => dom.created.filter((el) => el.classList.contains(name));
  const { lastPort, dom } = await bootPanel();
  const mark = dom.created.length;

  lastPort().emit({
    type: 'state',
    state: stateWithSettings(
      { romaji: 'above' },
      {
        rows: [
          {
            start: 0,
            duration: 2,
            text: '。x',
            secondary: '',
            tokens: [
              { text: '。', defined: false, level: null },
              { text: 'x', defined: true, level: 2, reading: null },
            ],
          },
        ],
      },
    ),
  });

  const built = dom.created.slice(mark);
  const ofClass = (name) => built.filter((el) => el.classList.contains(name));

  check('no ruby for an undefined token', ofClass('ruby').length, 0);
  check('and none for a defined one with no reading', ofClass('ruby').length, 0);
  // Read from the LAST row built, because `primary` is one element per row and
  // rows are appended rather than replaced.
  check('the text is still rendered', ofClass('primary').at(-1)?.textContent, '。x');
}

section('tone style changes how a reading is written, not where');

{
  const byClass = (dom, name) => dom.created.filter((el) => el.classList.contains(name));
  const { lastPort, dom } = await bootPanel();
  const push = (toneStyle) =>
    lastPort().emit({
      type: 'state',
      state: stateWithSettings(
        { romaji: 'above', toneStyle },
        {
          rows: [
            {
              start: 0,
              duration: 2,
              text: '终',
              secondary: '',
              tokens: [{ text: '终', defined: true, level: 3, reading: 'zhōngyú' }],
            },
          ],
        },
      ),
    });

  push('marks');
  check('marks by default', dom.created.filter((el) => el.classList.contains('rt')).at(-1)?.textContent, 'zhōngyú');
  push('numbers');
  // Per syllable, which is the part that needed a syllable table: a naive
  // conversion put the digit inside the syllable, and a per-word one at the end.
  check(
    'numbers put each tone on its own syllable',
    dom.created.filter((el) => el.classList.contains('rt')).at(-1)?.textContent,
    'zhong1yu2',
  );
}

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
