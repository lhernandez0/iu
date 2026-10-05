/**
 * Side panel — a subscriber, not a controller.
 *
 * It holds no transcript cache and makes no decisions: the service worker owns
 * the table, resolves the video, and pushes STATE whenever anything changes.
 * The panel renders what it is handed and sends back intents (pick a language,
 * seek, refresh). That split is what lets the panel be closed and reopened, or
 * the active tab switched, without losing anything.
 *
 * The only state here is render bookkeeping, so a STATE push can avoid
 * rebuilding every row when nothing but a dropdown changed.
 */

import { MSG, TARGET } from '../common/messages.js';
import { formatTimestamp, formatSrtTime, toPlainText } from '../common/transcript.js';

/**
 * Phase switch. True drives the parked tabCapture -> offscreen -> engine path
 * (whose engine is still a stub). False reads captions from the page.
 */
const USE_AUDIO_CAPTURE = false;

const els = {
  primary: /** @type {HTMLSelectElement} */ (document.getElementById('primary')),
  secondary: /** @type {HTMLSelectElement} */ (document.getElementById('secondary')),
  swap: /** @type {HTMLButtonElement} */ (document.getElementById('swap')),
  follow: /** @type {HTMLInputElement} */ (document.getElementById('follow')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  transcript: /** @type {HTMLElement} */ (document.getElementById('transcript')),
  copy: /** @type {HTMLButtonElement} */ (document.getElementById('copy')),
  format: /** @type {HTMLSelectElement} */ (document.getElementById('format')),
  save: /** @type {HTMLButtonElement} */ (document.getElementById('save')),
};

/** Render bookkeeping only — the transcript itself lives in the service worker. */
const view = {
  /** @type {object[]} */ rows: [],
  /** @type {HTMLElement[]} */ elements: [],
  activeIndex: -1,
  autoScroll: true,
  title: '',
  /** Primary language the current rows were rendered from. */
  renderedPrimary: null,
};

// --- Worker port ------------------------------------------------------------
// A connected port keeps the service worker alive, which is what preserves its
// cache while the panel is open.

const port = chrome.runtime.connect({ name: 'panel' });

port.onMessage.addListener((message) => {
  if (message.type === MSG.STATE) {
    renderState(message.state);
    return;
  }
  if (message.type === MSG.POSITION) {
    if (message.index < view.rows.length) setActive(message.index);
    return;
  }
  if (message.type === MSG.ERROR) {
    setStatus(message.error, true);
  }
});

/** @param {object} message */
function send(message) {
  port.postMessage({ ...message, target: TARGET.BACKGROUND });
}

// No initial REFRESH is sent: the worker resolves the current tab when the port
// connects, so asking here would duplicate the content-script round trip.

// --- State rendering --------------------------------------------------------

/** @param {object} state */
function renderState(state) {
  renderPickers(state);
  renderStatus(state);
  renderRows(state);
}

/** @param {object} state */
function renderPickers(state) {
  const tracks = state.trackList ?? [];

  fillSelect(els.primary, tracks, state.primary, 'Primary');
  // "Off" first, so a second language is opt-in rather than a surprise.
  fillSelect(els.secondary, tracks, state.secondary, 'Off', { includeNone: true });

  els.swap.disabled = !state.secondary;
  els.swap.title = state.secondary
    ? `Swap ${state.primary} and ${state.secondary}`
    : 'No second language selected';
}

/**
 * @param {HTMLSelectElement} select
 * @param {object[]} tracks
 * @param {string|null} selected
 * @param {string} placeholder
 * @param {{includeNone?: boolean}} [options]
 */
function fillSelect(select, tracks, selected, placeholder, { includeNone = false } = {}) {
  // Rebuilding a select resets focus mid-interaction, so only do it when the
  // contents would actually differ.
  const signature = tracks.map((t) => t.languageCode).join(',') + `|${selected}|${includeNone}`;
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;

  select.replaceChildren();

  if (!tracks.length) {
    select.append(new Option(placeholder, ''));
    select.disabled = true;
    return;
  }

  select.disabled = false;
  if (includeNone) select.append(new Option('Off', ''));

  for (const track of tracks) {
    const label = track.kind === 'asr' ? `${track.name} (auto)` : track.name;
    const option = new Option(label, track.languageCode);
    option.selected = track.languageCode === selected;
    select.append(option);
  }
}

/** @param {object} state */
function renderStatus(state) {
  view.title = state.title ?? '';

  if (state.error) {
    setStatus(state.error, true);
    return;
  }
  if (!state.rows?.length) {
    setStatus('No transcript for this video.');
    return;
  }
  const langs = state.secondary ? `${state.primary} + ${state.secondary}` : state.primary;
  setStatus(`${state.rows.length} lines · ${langs} · ${state.title}`);
}

// --- Controls ---------------------------------------------------------------

els.primary.addEventListener('change', () => {
  send({ type: MSG.SET_PRIMARY, languageCode: els.primary.value });
});

els.secondary.addEventListener('change', () => {
  send({ type: MSG.SET_SECONDARY, languageCode: els.secondary.value || null });
});

els.swap.addEventListener('click', () => {
  const primary = els.primary.value;
  const secondary = els.secondary.value;
  if (!secondary) return;
  send({ type: MSG.SET_PRIMARY, languageCode: secondary });
  send({ type: MSG.SET_SECONDARY, languageCode: primary || null });
});

els.follow.addEventListener('change', () => {
  view.autoScroll = els.follow.checked;
  if (view.autoScroll) view.elements[view.activeIndex]?.scrollIntoView({ block: 'nearest' });
});

els.copy.addEventListener('click', () => {
  const text = toBilingualText(view.rows.some((row) => row.secondary));
  if (text) void navigator.clipboard.writeText(text);
});

els.save.addEventListener('click', () => {
  if (!view.rows.length) return;

  const bilingual = view.rows.some((row) => row.secondary);
  const format = els.format.value;
  const body = format === 'srt' ? toBilingualSrt() : toBilingualText(bilingual);
  const name = (view.title || 'transcript').replace(/[^\w.-]+/g, '_').slice(0, 60);

  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.${format}`;
  link.click();
  URL.revokeObjectURL(url);
});

/** Exports carry both languages when a second one is selected. @param {boolean} bilingual */
function toBilingualText(bilingual) {
  if (!bilingual) return toPlainText(view.rows);
  return view.rows.map((row) => (row.secondary ? `${row.text}\n${row.secondary}` : row.text)).join('\n');
}

function toBilingualSrt() {
  return view.rows
    .map((row, index) => {
      const start = formatSrtTime(row.start);
      const end = formatSrtTime(row.start + (row.duration || 1));
      const text = row.secondary ? `${row.text}\n${row.secondary}` : row.text;
      return `${index + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
}

// --- Rendering --------------------------------------------------------------

/** @param {object} state */
function renderRows(state) {
  const rows = state.rows ?? [];

  // Rebuild only when the data actually changed. A STATE push that only moved
  // a dropdown must not tear down thousands of rows.
  if (rows === view.rows && state.primary === view.renderedPrimary) return;

  view.rows = rows;
  view.renderedPrimary = state.primary;
  view.elements = [];
  view.activeIndex = -1;
  els.transcript.replaceChildren();

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No transcript loaded.';
    els.transcript.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const [index, row] of rows.entries()) {
    fragment.append(buildRow(row, index));
  }
  els.transcript.append(fragment);
}

/**
 * @param {{start: number, text: string, secondary: string}} row
 * @param {number} index
 * @returns {HTMLElement}
 */
function buildRow(row, index) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'row';
  element.title = 'Jump to this line';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTimestamp(row.start);
  element.append(time);

  const lines = document.createElement('span');
  lines.className = 'lines';

  const primary = document.createElement('span');
  primary.className = 'primary';
  primary.textContent = row.text;
  lines.append(primary);

  if (row.secondary) {
    const secondary = document.createElement('span');
    secondary.className = 'secondary';
    secondary.textContent = row.secondary;
    lines.append(secondary);
  }

  element.append(lines);
  // The index is not used: the worker already knows the offset and the content
  // script owns the video element.
  element.addEventListener('click', () => send({ type: MSG.SEEK, seconds: row.start }));
  void index;
  view.elements.push(element);
  return element;
}

/** @param {number} index */
function setActive(index) {
  if (index === view.activeIndex) return;
  view.elements[view.activeIndex]?.classList.remove('active');
  view.activeIndex = index;
  if (index < 0) return;

  const element = view.elements[index];
  if (!element) return;
  element.classList.add('active');
  if (view.autoScroll) element.scrollIntoView({ block: 'nearest' });
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

// --- Parked audio path -------------------------------------------------------
// Kept reachable so the capture phase can be re-enabled by flipping
// USE_AUDIO_CAPTURE. The offscreen document and stub engine are untouched.

async function enableAudioCapture() {
  const { startAudioCapture, stopAudioCapture } = await import('./audio-capture.js');
  els.transcript.replaceChildren();
  els.primary.hidden = true;
  els.secondary.hidden = true;
  els.follow.hidden = true;
  els.swap.textContent = 'Start';

  els.swap.addEventListener('click', () => {
    const running = els.swap.dataset.running === 'true';
    const action = running ? stopAudioCapture() : startAudioCapture();
    void action
      .then(() => {
        els.swap.dataset.running = String(!running);
        els.swap.textContent = running ? 'Start' : 'Stop';
      })
      .catch((error) => setStatus(String(error.message ?? error), true));
  });
}

if (USE_AUDIO_CAPTURE) void enableAudioCapture();

setStatus('Looking for a YouTube video…');
