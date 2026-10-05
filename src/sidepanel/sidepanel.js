/**
 * Side panel — the user-facing surface.
 *
 * It owns no audio: it asks the service worker to start a capture and then
 * renders whatever the offscreen document's engine reports. The capture is
 * scoped to the tab that was active when Start was pressed.
 */

import { MSG, TARGET } from '../common/messages.js';

const els = {
  toggle: /** @type {HTMLButtonElement} */ (document.getElementById('toggle')),
  monitor: /** @type {HTMLInputElement} */ (document.getElementById('monitor')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  transcript: /** @type {HTMLElement} */ (document.getElementById('transcript')),
  copy: /** @type {HTMLButtonElement} */ (document.getElementById('copy')),
  clear: /** @type {HTMLButtonElement} */ (document.getElementById('clear')),
  save: /** @type {HTMLButtonElement} */ (document.getElementById('save')),
};

/**
 * @typedef {Object} PanelState
 * @property {boolean} capturing
 * @property {string[]} finals       Committed text, in order.
 * @property {string} partial        Current hypothesis ('' when none).
 * @property {string} tabTitle
 */

/** @type {PanelState} */
const state = { capturing: false, finals: [], partial: '', tabTitle: '' };

// --- Controls ---------------------------------------------------------------

els.toggle.addEventListener('click', () => {
  void (state.capturing ? stop() : start());
});

els.monitor.addEventListener('change', () => {
  void chrome.runtime
    .sendMessage({
      type: MSG.SET_MONITOR_MUTED,
      target: TARGET.BACKGROUND,
      muted: !els.monitor.checked,
    })
    .catch(() => {});
});

els.copy.addEventListener('click', () => {
  const text = state.finals.join('\n');
  if (text) void navigator.clipboard.writeText(text);
});

els.clear.addEventListener('click', () => {
  state.finals = [];
  state.partial = '';
  render();
});

els.save.addEventListener('click', () => {
  const text = state.finals.join('\n');
  if (!text) return;
  const name = (state.tabTitle || 'transcript').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.txt`;
  link.click();
  URL.revokeObjectURL(url);
});

// --- Capture lifecycle ------------------------------------------------------

async function start() {
  setStatus('Starting…');
  try {
    // Capture the tab the side panel is open beside, not the panel's own tab.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab to capture.');

    // Only the service worker may mint the stream id ($1 in the worker comment).
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

    const reply = await chrome.runtime.sendMessage({
      type: MSG.START_CAPTURE,
      target: TARGET.BACKGROUND,
      streamId,
      tabId: tab.id,
      tabTitle: tab.title ?? '',
    });
    if (!reply?.ok) throw new Error(reply?.error ?? 'Capture failed.');

    state.tabTitle = tab.title ?? '';
  } catch (error) {
    setStatus(String(error.message ?? error), true);
    state.capturing = false;
    renderControls();
  }
}

async function stop() {
  await chrome.runtime.sendMessage({ type: MSG.STOP_CAPTURE, target: TARGET.BACKGROUND }).catch(() => {});
}

// --- Messages from the offscreen document -----------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== TARGET.SIDEPANEL) return;

  switch (message.type) {
    case MSG.CAPTURE_STARTED:
      state.capturing = true;
      state.tabTitle = message.tabTitle || state.tabTitle;
      setStatus(state.tabTitle ? `Capturing: ${state.tabTitle}` : 'Capturing');
      renderControls();
      break;

    case MSG.CAPTURE_STOPPED:
      state.capturing = false;
      setStatus('Stopped');
      renderControls();
      break;

    case MSG.CAPTURE_ERROR:
      state.capturing = false;
      setStatus(message.error, true);
      renderControls();
      break;

    case MSG.ENGINE_EVENT:
      applyEvent(message.event);
      break;
  }
});

/** @param {import('../engines/engine.js').TranscriptEvent} event */
function applyEvent(event) {
  if (event.kind === 'final') {
    state.finals.push(event.text);
    state.partial = '';
  } else {
    state.partial = event.text;
  }
  render();
}

// --- Rendering --------------------------------------------------------------

function render() {
  els.transcript.replaceChildren();

  if (state.finals.length === 0 && !state.partial) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.capturing ? 'Listening…' : 'Press Start to transcribe the current tab.';
    els.transcript.append(empty);
    return;
  }

  for (const text of state.finals) {
    const p = document.createElement('p');
    p.className = 'segment';
    p.textContent = text;
    els.transcript.append(p);
  }

  if (state.partial) {
    const partialEl = document.createElement('p');
    partialEl.className = 'partial';
    partialEl.textContent = state.partial;
    els.transcript.append(partialEl);
  }

  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function renderControls() {
  els.toggle.textContent = state.capturing ? 'Stop' : 'Start';
  els.toggle.setAttribute('aria-pressed', String(state.capturing));
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

render();
renderControls();
