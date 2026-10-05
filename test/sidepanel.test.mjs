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
  'swap',
  'view-mode',
  'text-scale',
  'list',
  'threshold',
  'follow',
  'status',
  'transcript',
  'copy',
  'format',
  'save',
];

/**
 * Evaluate a fresh copy of the panel against fresh stubs.
 *
 * @param {{failWith?: string}} [options]
 * @returns {Promise<{ports: object[], lastPort: Function, lastErrorRead: Function, created: object[], byId: Map<string, object>, dom: object}>}
 */
async function bootPanel(options = {}) {
  const dom = installDomStub(PANEL_IDS);
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
 * @param {object} [learning]
 */
const stateWithSettings = (learning) => ({
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
  learning: {
    view: 'all',
    textScale: 1,
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
  check('status names the language', textOf(byId.get('status')).includes('en'), true);
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
  check('the root scale is untouched by the view', dom.document.documentElement.style.getPropertyValue('--text-scale'), '1');
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

section('text size is a scale factor applied to the document root');

{
  const { lastPort, dom, byId } = await bootPanel();

  lastPort().emit({ type: 'state', state: stateWithSettings({ textScale: 1 }) });
  check('the default is 1', dom.document.documentElement.style.getPropertyValue('--text-scale'), '1');

  lastPort().emit({ type: 'state', state: stateWithSettings({ textScale: 1.45 }) });
  check('a larger size is applied', dom.document.documentElement.style.getPropertyValue('--text-scale'), '1.45');

  // Sent to the worker too, so the choice survives closing the panel.
  const port = lastPort();
  byId.get('text-scale').value = '1.75';
  byId.get('text-scale').dispatch('change');
  check('changing it sends SET_SETTING', port.sent.at(-1)?.type, 'set-setting');
  check('for the textScale setting', port.sent.at(-1)?.id, 'textScale');
  check('with a number, not a string', port.sent.at(-1)?.value, 1.75);
  check('and applies immediately, without waiting for the worker', dom.document.documentElement.style.getPropertyValue('--text-scale'), '1.75');
}

section('the focus view sends its change too, and applies at once');

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
  const scaleOptions = byId.get('text-scale').find((el) => el.tagName === 'OPTION');

  check('the view offers both modes', viewOptions.length, 2);
  check('named as the schema names them', viewOptions.map((o) => o.text), ['All lines', 'Current + next']);
  check('with the schema values', viewOptions.map((o) => o.value), ['all', 'focus']);
  check('and text sizes are offered', scaleOptions.length > 2, true);
}

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
