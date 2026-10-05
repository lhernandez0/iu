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
import { definition } from '../common/settings.js';
import { attachHover, showEntry, hide as hidePopover, renderTokens } from './marks.js';

/**
 * Options for the settings this panel renders itself.
 *
 * Read from the schema so a label or a value lives in one place, rather than
 * being duplicated here and in the worker and drifting apart.
 *
 * @param {string} id
 * @returns {Array<{value: any, label: string}>}
 */
function optionsFor(id) {
  return definition(id)?.options ?? [];
}

const VIEW_OPTIONS = optionsFor('view');
const TEXT_SCALE_OPTIONS = optionsFor('textScale');

/**
 * Phase switch. True drives the parked tabCapture -> offscreen -> engine path
 * (whose engine is still a stub). False reads captions from the page.
 */
const USE_AUDIO_CAPTURE = false;

/** Worker-connection tuning. Backoff is capped so a long-lived panel keeps trying. */
const NO_WORKER_MS = 5000;
/** How long to wait before nudging a silent worker, as opposed to giving up on it. */
const RETRY_AFTER_MS = 1200;
const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 6;

const els = {
  primary: /** @type {HTMLSelectElement} */ (document.getElementById('primary')),
  secondary: /** @type {HTMLSelectElement} */ (document.getElementById('secondary')),
  swap: /** @type {HTMLButtonElement} */ (document.getElementById('swap')),
  list: /** @type {HTMLSelectElement} */ (document.getElementById('list')),
  threshold: /** @type {HTMLSelectElement} */ (document.getElementById('threshold')),
  viewMode: /** @type {HTMLSelectElement} */ (document.getElementById('view-mode')),
  textScale: /** @type {HTMLSelectElement} */ (document.getElementById('text-scale')),
  follow: /** @type {HTMLInputElement} */ (document.getElementById('follow')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  transcript: /** @type {HTMLElement} */ (document.getElementById('transcript')),
  copy: /** @type {HTMLButtonElement} */ (document.getElementById('copy')),
  format: /** @type {HTMLSelectElement} */ (document.getElementById('format')),
  save: /** @type {HTMLButtonElement} */ (document.getElementById('save')),
};

/** Bookkeeping only — the transcript itself lives in the service worker. */
const view = {
  /** @type {object[]} */ rows: [],
  /** @type {HTMLElement[]} */ elements: [],
  activeIndex: -1,
  autoScroll: true,
  title: '',
  /** Primary language the current rows were rendered from. */
  renderedPrimary: null,
  /** Levels in the active word list, which the colour ramp divides by. */
  levelCount: 0,
  palette: undefined,
  /** The word whose definition is being shown, so a late reply is not stale. */
  hoveredWord: null,
  /** Whether the panel is showing only the current line and the next. */
  focusMode: false,
};

// --- Worker port ------------------------------------------------------------
// A connected port keeps the service worker alive, which is what preserves its
// cache while the panel is open.
//
// Connecting can fail, and did: an MV3 worker is stopped when idle, and a panel
// left open across an extension reload belongs to a dead extension instance. In
// both cases `connect` has no receiver, Chrome reports "Could not establish
// connection. Receiving end does not exist", and a panel with no reconnect path
// sits on its placeholder forever. So the port is re-established on disconnect.

/** @type {chrome.runtime.Port|null} */
let port = null;
let reconnectDelay = INITIAL_RECONNECT_MS;
let reconnectTimer = 0;
let reconnectAttempts = 0;

// If the worker never answers — it crashed, or never woke — say so rather than
// showing the startup placeholder indefinitely. A slow worker answers well
// inside this window.
let heardFromWorker = false;
let workerWatchdog = 0;

function connectToWorker() {
  clearTimeout(reconnectTimer);

  try {
    port = chrome.runtime.connect({ name: 'panel' });
  } catch (error) {
    // "Extension context invalidated": this panel document outlived the
    // extension it belongs to. Only reopening the panel can fix that, and no
    // amount of retrying will help.
    setStatus(
      `This panel is out of date (${error?.message ?? error}). Close and reopen it.`,
      true,
    );
    return;
  }

  port.onMessage.addListener(onWorkerMessage);
  port.onDisconnect.addListener(() => {
    // Reading lastError is required even though we only want the message: an
    // unread lastError is what Chrome logs as "Unchecked runtime.lastError".
    const reason = chrome.runtime.lastError?.message ?? 'the worker stopped';
    port = null;
    scheduleReconnect(reason);
  });

  reconnectDelay = INITIAL_RECONNECT_MS;
  reconnectAttempts = 0;

  // The worker resolves the current tab when the port connects, so no outgoing
  // request is needed here.
}

/** @param {string} reason */
function scheduleReconnect(reason) {
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    setStatus(
      `Lost the extension worker (${reason}) and could not reconnect. Reload the extension in chrome://extensions, then reopen this panel.`,
      true,
    );
    return;
  }

  setStatus(`Lost the extension worker (${reason}). Reconnecting…`, true);
  reconnectTimer = setTimeout(connectToWorker, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
}

/** @param {object} message */
function onWorkerMessage(message) {
  heardFromWorker = true;
  clearTimeout(workerWatchdog);

  try {
    if (message.type === MSG.STATE) {
      renderState(message.state);
      // A state push carries the current cue, so a panel opened mid-video lands
      // on the line being spoken instead of the top of the transcript. This is
      // what makes Follow true from the moment the panel appears: without it the
      // panel hears nothing until the next cue change, which on a paused video
      // never comes.
      if (message.state?.activeIndex >= 0) setActive(message.state.activeIndex);
      return;
    }
    if (message.type === MSG.POSITION) {
      if (message.index < view.rows.length) setActive(message.index);
      return;
    }
    if (message.type === MSG.ENTRY) {
      // Ignore a reply for a word the pointer has already left, so a slow lookup
      // cannot pop a definition over the wrong token.
      if (message.word === view.hoveredWord) showEntry(message);
      return;
    }
    if (message.type === MSG.ERROR) {
      setStatus(message.error, true);
    }
  } catch (error) {
    // Surface it. A render failure would otherwise leave the placeholder text on
    // screen, which looks exactly like the extension doing nothing.
    setStatus(`Panel error: ${error?.message ?? error}`, true);
  }
}

// Hover is delegated to the transcript container rather than attached per token:
// a long transcript is thousands of tokens, and one listener costs less than the
// marks themselves.
attachHover(els.transcript, (word) => {
  view.hoveredWord = word;
  send({ type: MSG.LOOKUP, word });
});

// Leaving the transcript entirely dismisses the popover. The delegated handler
// cannot see this, because it only fires inside the container.
els.transcript.addEventListener('mouseleave', () => {
  view.hoveredWord = null;
  hidePopover();
});

/**
 * @param {object} message
 * @returns {boolean} Whether it was sent.
 */
function send(message) {
  if (!port) return false;
  try {
    port.postMessage({ ...message, target: TARGET.BACKGROUND });
    return true;
  } catch {
    // The port died between the check and the send; the disconnect handler will
    // reconnect and refresh, which restores whatever this intent would have done.
    return false;
  }
}

/**
 * If the worker never answers, nudge it once before complaining.
 *
 * The worker resolves the video from whichever tab is active. When the panel is
 * opened, that can momentarily be the panel's own tab — there is no video in it,
 * so the worker reports that and has no reason to look again. A retry once
 * things have settled recovers from that, and from a worker still waking up.
 *
 * The retry comes quickly because a healthy worker answers in well under a
 * second; making the user wait five seconds for a recoverable miss would be
 * worse than the miss. Only if the retry also goes unanswered is something
 * actually wrong.
 */
workerWatchdog = setTimeout(() => {
  if (heardFromWorker) return;
  send({ type: MSG.REFRESH });

  workerWatchdog = setTimeout(() => {
    if (heardFromWorker) return;
    setStatus(
      'No response from the extension worker. Reload the extension in chrome://extensions, then reopen this panel.',
      true,
    );
  }, NO_WORKER_MS);
}, RETRY_AFTER_MS);

// --- State rendering --------------------------------------------------------

/** @param {object} state */
function renderState(state) {
  if (!state || typeof state !== 'object') {
    setStatus('The worker sent an empty state.', true);
    return;
  }
  renderPickers(state);
  renderLearning(state);
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

/**
 * The settings controls, rendered from the schema in src/common/settings.js.
 *
 * Rendering from a schema rather than hand-writing each control is what keeps
 * adding a setting to one object plus one line of HTML, instead of a control,
 * a listener and a message each time.
 *
 * @param {object} state
 */
function renderLearning(state) {
  const learning = state.learning ?? {};

  fillSelect(
    els.list,
    (learning.listOptions ?? []).map((option) => ({ languageCode: option.value, name: option.label })),
    learning.listId,
    'Word list',
  );
  els.list.disabled = !learning.listOptions?.length;

  fillSelectOptions(els.threshold, learning.thresholdOptions ?? [], learning.threshold, '—');

  fillSelectOptions(els.viewMode, VIEW_OPTIONS, learning.view, 'All lines');
  fillSelectOptions(els.textScale, TEXT_SCALE_OPTIONS, learning.textScale, 'Normal');

  // Applied here rather than round-tripped through the worker: text size and the
  // focus view are pure presentation, so sending them anywhere would be a
  // message that changes nothing on the other side.
  applyTextScale(learning.textScale);
  applyView(learning.view);
}

/**
 * Fill a select from a list of {value,label}, rebuilding only when it differs.
 *
 * @param {HTMLSelectElement} select
 * @param {Array<{value: any, label: string}>} options
 * @param {any} selected
 * @param {string} placeholder Shown when there is nothing to choose.
 */
function fillSelectOptions(select, options, selected, placeholder) {
  const signature = options.map((option) => `${option.value}:${option.label}`).join(',') + `|${selected}`;
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;

  select.replaceChildren();
  if (!options.length) {
    select.append(new Option(placeholder, ''));
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const option of options) {
    const element = new Option(option.label, String(option.value));
    element.selected = String(option.value) === String(selected);
    select.append(element);
  }
}

/**
 * Text size is a single scale factor on the root element.
 *
 * Every size in the stylesheet is expressed as `calc(<px> * var(--text-scale))`,
 * because the alternative — one variable holding a size that other rules
 * override — cannot move nine separate sizes together.
 *
 * @param {number} scale
 */
function applyTextScale(scale) {
  const value = Number.isFinite(Number(scale)) ? Number(scale) : 1;
  document.documentElement.style.setProperty('--text-scale', String(value));
}

/**
 * Show either the whole transcript or the current line with the next one.
 *
 * Applied as a class on the list rather than by re-rendering, so switching modes
 * is instant and the marks, hover handling and seek listeners all survive
 * untouched — the rows are the same rows.
 *
 * @param {string} mode
 */
function applyView(mode) {
  view.focusMode = mode === 'focus';
  els.transcript.classList.toggle('focus', view.focusMode);
  // Entering focus mode has to reveal the current line, which the normal render
  // path would not do because nothing about the rows changed.
  if (view.focusMode) revealNearActive();
}

/**
 * Scroll the current line into view.
 *
 * Centred rather than nearest, because the focus view keeps the next line
 * visible too — scrolling to the edge would leave the preview just below the
 * fold.
 */
function revealNearActive() {
  const row = view.elements[view.activeIndex];
  if (row) row.scrollIntoView({ block: 'center' });
}

// --- Controls ---------------------------------------------------------------

els.primary.addEventListener('change', () => {
  send({ type: MSG.SET_PRIMARY, languageCode: els.primary.value });
});

els.secondary.addEventListener('change', () => {
  send({ type: MSG.SET_SECONDARY, languageCode: els.secondary.value || null });
});

els.list.addEventListener('change', () => {
  send({ type: MSG.SET_LIST, listId: els.list.value });
});

els.threshold.addEventListener('change', () => {
  send({ type: MSG.SET_THRESHOLD, threshold: Number(els.threshold.value) });
});

// Both of these are presentation only, so they are applied locally and also
// sent to be remembered. The worker does nothing with them beyond storing them,
// which is why there is no round trip that could change what is on screen.
els.viewMode.addEventListener('change', () => {
  applyView(els.viewMode.value);
  send({ type: MSG.SET_SETTING, id: 'view', value: els.viewMode.value });
});

els.textScale.addEventListener('change', () => {
  applyTextScale(Number(els.textScale.value));
  send({ type: MSG.SET_SETTING, id: 'textScale', value: Number(els.textScale.value) });
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

  // The colour ramp needs the active list's level count before any row renders,
  // so it is captured here rather than looked up per token.
  const active = (state.lists ?? []).find((list) => list.id === state.learning?.listId);
  view.levelCount = active?.levelCount ?? 0;

  // A row's tokens are attached after the transcript arrives, so the rows array
  // is replaced rather than mutated — which is what makes this identity check
  // work for both the initial render and the later marked render.
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
 * @param {{start: number, text: string, secondary: string, tokens?: Array<{text: string, level: number|null}>}} row
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

  // Tokens arrive from the worker once the word list has loaded, which is not
  // necessarily by the time the transcript does. Until then the line renders as
  // plain text, so the transcript is never withheld waiting on the dictionary.
  if (row.tokens) {
    primary.append(renderTokens(row.tokens, view.levelCount, view.palette));
  } else {
    primary.textContent = row.text;
  }
  lines.append(primary);

  if (row.secondary) {
    const secondary = document.createElement('span');
    secondary.className = 'secondary';
    secondary.textContent = row.secondary;
    lines.append(secondary);
  }

  element.append(lines);
  // Highlight straight away as well as asking for the seek. Waiting for the
  // round trip means the highlight lags the click by up to a poll interval, and
  // if the video is paused, nothing moves at all.
  element.addEventListener('click', () => {
    setActive(index);
    send({ type: MSG.SEEK, seconds: row.start });
  });
  view.elements.push(element);
  return element;
}

/** @param {number} index */
function setActive(index) {
  if (index === view.activeIndex) return;
  view.elements[view.activeIndex]?.classList.remove('active');
  // The previous successor is no longer the successor.
  view.elements[view.activeIndex + 1]?.classList.remove('next');
  view.activeIndex = index;
  if (index < 0) return;

  const element = view.elements[index];
  if (!element) return;
  element.classList.add('active');

  // The next line is marked so the focus view can reveal it as a preview. The
  // class is applied in both modes because it costs nothing and switching view
  // should not need a re-render to become correct.
  view.elements[index + 1]?.classList.add('next');

  if (!view.autoScroll) return;
  // In focus mode the current line is centred, because the preview sits below
  // it and scrolling to the edge would push it off screen.
  element.scrollIntoView({ block: view.focusMode ? 'center' : 'nearest' });
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

// --- Boot -------------------------------------------------------------------

setStatus('Looking for a YouTube video…');
connectToWorker();
