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

// --- Result ------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
