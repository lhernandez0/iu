/**
 * Bootstraps the panel inside the preview.
 *
 * Three jobs, in order: install the fake Port, fetch the scenario the URL asks
 * for, and then import the panel. The import has to be LAST and dynamic, the
 * panel calls `chrome.runtime.connect` at module scope, so the mock must already
 * be in place when it evaluates.
 *
 * This file is HMR-aware on purpose: editing the panel re-runs it, and a fresh
 * mock is created each time so a scenario change is not layered onto the previous
 * worker's state.
 *
 * Development only. Never loaded by the extension.
 */

import { installMockChrome } from './mock-worker.mjs';

/**
 * @param {string} id
 * @returns {Promise<object>}
 */
async function fetchScenario(id) {
  const response = await fetch(`/api/scenario?scenario=${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`scenario "${id}" could not be loaded (${response.status})`);
  return response.json();
}

/** The scenario switcher, drawn from the server's index. */
async function renderSwitcher(currentId) {
  const nav = document.getElementById('preview-scenarios');
  const note = document.getElementById('preview-note');
  const scenarios = await (await fetch('/api/scenario-index')).json();

  nav.replaceChildren();
  for (const scenario of scenarios) {
    const link = document.createElement('a');
    link.className = `preview-scenario${scenario.id === currentId ? ' on' : ''}`;
    link.href = `?scenario=${scenario.id}`;
    link.title = scenario.note;
    link.textContent = scenario.label;
    nav.append(link);
    if (scenario.id === currentId) note.textContent = scenario.note;
  }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const id = params.get('scenario') ?? 'bilingual';

  const scenario = await fetchScenario(id);
  document.title = `IU preview, ${scenario.label}`;
  await renderSwitcher(id);

  const { worker } = installMockChrome(scenario);

  // Settings overrides from the URL, so a layout can be linked to and reloaded
  // rather than rebuilt by clicking. Vite's HMR makes them less essential than
  // they were, an edit lands without a reload, but a link is still how one
  // state gets shared or returned to.
  const patch = {};
  if (params.has('view')) patch.view = params.get('view');
  if (params.has('fontSize')) patch.fontSize = Number(params.get('fontSize'));
  if (params.has('threshold')) patch.threshold = Number(params.get('threshold'));
  // So a mark treatment can be linked to and compared, rather than rebuilt by
  // hand each time. This is the only way to see `highlight` in the preview at all
  // while the setting has no control.
  if (params.has('markStyle')) patch.markStyle = params.get('markStyle');
  for (const [setting, value] of Object.entries(patch)) {
    worker.port.received({ type: 'set-setting', id: setting, value, target: 'background' });
  }

  // Last, so the mock exists before the panel connects.
  await import('/src/sidepanel/sidepanel.js');
  worker.start();

  return worker;
}

let worker = await boot();

// Clean up the mock's timer when Vite replaces this module.
//
// Deliberately NOT forcing a reload on every update. Vite handles the two kinds
// of change differently and correctly on its own: a stylesheet edit is injected
// without a reload, which is the entire point of using a dev server here, while
// a panel module edit falls back to a full reload, because `sidepanel.js` accepts
// no hot updates and mounting it twice is not a lifecycle that exists in a real
// side panel. Intercepting `vite:beforeUpdate` would have turned the CSS case
// back into a reload and thrown the benefit away.
if (import.meta.hot) {
  import.meta.hot.dispose(() => worker?.stop?.());
}
