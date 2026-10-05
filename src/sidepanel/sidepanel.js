/**
 * Side panel — the user-facing surface.
 *
 * This phase reads YouTube's OWN captions rather than capturing audio: it asks
 * the page's content script for the transcript, renders one clickable row per
 * segment, and seeks the page's video when a row is clicked. The audio path is
 * parked behind USE_AUDIO_CAPTURE.
 */

import { MSG, TARGET } from '../common/messages.js';
import { formatTimestamp, toPlainText, toSrt } from '../common/transcript.js';

/**
 * Phase switch. True drives the parked tabCapture -> offscreen -> engine path
 * (whose engine is still a stub). False reads captions from the page.
 */
const USE_AUDIO_CAPTURE = false;

const els = {
  load: /** @type {HTMLButtonElement} */ (document.getElementById('load')),
  track: /** @type {HTMLSelectElement} */ (document.getElementById('track')),
  follow: /** @type {HTMLInputElement} */ (document.getElementById('follow')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  transcript: /** @type {HTMLElement} */ (document.getElementById('transcript')),
  copy: /** @type {HTMLButtonElement} */ (document.getElementById('copy')),
  clear: /** @type {HTMLButtonElement} */ (document.getElementById('clear')),
  format: /** @type {HTMLSelectElement} */ (document.getElementById('format')),
  save: /** @type {HTMLButtonElement} */ (document.getElementById('save')),
};

/** @typedef {{start: number, duration: number, text: string}} Segment */

const state = {
  /** @type {Segment[]} */ segments: [],
  activeIndex: -1,
  title: '',
  loading: false,
  /** @type {number|null} */ activeTabId: null,
  /** @type {HTMLElement[]} */ rows: [],
  autoScroll: true,
};

// --- Content-script channel -------------------------------------------------

/** @returns {Promise<number|null>} Id of a tab showing YouTube, if any. */
async function findYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && /^https:\/\/[^/]*youtube\.com\//.test(tab.url ?? '')) return tab.id;

  // The side panel is its own context, so the active tab is not necessarily
  // the one playing video.
  const candidates = await chrome.tabs.query({ url: 'https://*.youtube.com/*' });
  return candidates[0]?.id ?? null;
}

/**
 * @param {object} message
 * @returns {Promise<any>}
 */
async function askContent(message) {
  const tabId = state.activeTabId ?? (await findYouTubeTab());
  if (tabId === null) throw new Error('No YouTube tab found.');
  state.activeTabId = tabId;

  try {
    return await chrome.tabs.sendMessage(tabId, { ...message, target: TARGET.CONTENT });
  } catch {
    // Usually means the content script is not there: not a watch page, or the
    // extension was reloaded after the tab loaded. Retrying will not help.
    throw new Error('Could not reach the page. Reload the YouTube tab and try again.');
  }
}

// --- Loading ----------------------------------------------------------------

/** @param {string} [languageCode] */
async function load(languageCode) {
  if (state.loading) return;
  state.loading = true;
  els.load.disabled = true;
  setStatus('Loading captions…');

  try {
    const snapshot = await askContent({ type: MSG.GET_TRANSCRIPT, languageCode: languageCode ?? null });
    state.segments = snapshot?.segments ?? [];
    state.title = snapshot?.title ?? '';
    state.activeIndex = -1;
    renderTracks(snapshot?.tracks ?? [], snapshot?.languageCode ?? null);
    render();

    if (snapshot?.error) setStatus(snapshot.error, true);
    else if (state.segments.length) setStatus(`${state.segments.length} lines · ${state.title}`);
    else setStatus('No caption text came back for this video.', true);
  } catch (error) {
    setStatus(String(error.message ?? error), true);
  } finally {
    state.loading = false;
    els.load.disabled = false;
  }
}

/**
 * @param {object[]} tracks
 * @param {string|null} current
 */
function renderTracks(tracks, current) {
  els.track.replaceChildren();
  if (!tracks.length) {
    els.track.disabled = true;
    return;
  }
  els.track.disabled = false;
  for (const track of tracks) {
    const option = document.createElement('option');
    option.value = track.languageCode;
    option.textContent = track.kind === 'asr' ? `${track.name} (auto)` : track.name;
    option.selected = track.languageCode === current;
    els.track.append(option);
  }
}

// --- Controls ---------------------------------------------------------------

els.load.addEventListener('click', () => void load(els.track.value || undefined));

els.track.addEventListener('change', () => {
  state.segments = [];
  render();
  void load(els.track.value);
});

els.follow.addEventListener('change', () => {
  state.autoScroll = els.follow.checked;
  if (state.autoScroll) scrollToActive();
});

els.copy.addEventListener('click', () => {
  const text = toPlainText(state.segments);
  if (text) void navigator.clipboard.writeText(text);
});

els.clear.addEventListener('click', () => {
  state.segments = [];
  state.activeIndex = -1;
  els.track.replaceChildren();
  els.track.disabled = true;
  render();
  setStatus('Cleared.');
});

els.save.addEventListener('click', () => {
  if (!state.segments.length) return;

  const format = els.format.value;
  const body = format === 'srt' ? toSrt(state.segments) : toPlainText(state.segments);
  const name = (state.title || 'transcript').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.${format}`;
  link.click();
  URL.revokeObjectURL(url);
});

// --- Rendering --------------------------------------------------------------

function render() {
  els.transcript.replaceChildren();
  state.rows = [];

  if (!state.segments.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No transcript loaded.';
    els.transcript.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const [index, segment] of state.segments.entries()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.title = 'Jump to this line';

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTimestamp(segment.start);
    row.append(time);

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = segment.text;
    row.append(text);

    row.addEventListener('click', () => void seekTo(segment.start, index));
    fragment.append(row);
    state.rows.push(row);
  }

  els.transcript.append(fragment);
}

/** @param {number} index */
function setActive(index) {
  if (index === state.activeIndex) return;
  state.rows[state.activeIndex]?.classList.remove('active');
  state.activeIndex = index;
  if (index < 0) return;

  const row = state.rows[index];
  if (!row) return;
  row.classList.add('active');
  if (state.autoScroll) row.scrollIntoView({ block: 'nearest' });
}

function scrollToActive() {
  state.rows[state.activeIndex]?.scrollIntoView({ block: 'nearest' });
}

/**
 * @param {number} seconds
 * @param {number} index
 */
async function seekTo(seconds, index) {
  try {
    await askContent({ type: MSG.SEEK, seconds });
    // Move the highlight immediately rather than waiting for the page to
    // report its new position.
    setActive(index);
  } catch (error) {
    setStatus(String(error.message ?? error), true);
  }
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

// --- Messages from the content script ---------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== TARGET.SIDEPANEL) return;

  if (message.type === MSG.POSITION) {
    // Guard against a stale index from a previous transcript.
    if (message.index < state.segments.length) setActive(message.index);
    return;
  }

  if (message.type === MSG.TRANSCRIPT_INVALIDATED) {
    state.segments = [];
    state.activeIndex = -1;
    els.track.replaceChildren();
    els.track.disabled = true;
    render();
    setStatus('Video changed — load the transcript again.');
  }
});

// --- Parked audio path -------------------------------------------------------
// Kept wired so the capture phase can be re-enabled by flipping
// USE_AUDIO_CAPTURE. The offscreen document and stub engine are untouched.

async function enableAudioCapture() {
  const { startAudioCapture, stopAudioCapture } = await import('./audio-capture.js');
  els.load.textContent = 'Start';
  els.track.hidden = true;
  els.follow.hidden = true;
  els.load.addEventListener('click', () => {
    const running = els.load.getAttribute('aria-pressed') === 'true';
    const action = running ? stopAudioCapture() : startAudioCapture();
    void action
      .then(() => els.load.setAttribute('aria-pressed', String(!running)))
      .catch((error) => setStatus(String(error.message ?? error), true));
  });
}

if (USE_AUDIO_CAPTURE) void enableAudioCapture();

// --- Boot -------------------------------------------------------------------

render();
void (async () => {
  const tabId = await findYouTubeTab();
  if (tabId !== null) {
    state.activeTabId = tabId;
    await load();
  }
})();
