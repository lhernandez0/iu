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
  study: /** @type {HTMLSelectElement} */ (document.getElementById('study')),
  studyTranslated: /** @type {HTMLInputElement} */ (document.getElementById('study-translated')),
  gloss: /** @type {HTMLSelectElement} */ (document.getElementById('gloss')),
  glossTranslated: /** @type {HTMLInputElement} */ (document.getElementById('gloss-translated')),
  translateTargetRow: /** @type {HTMLElement} */ (document.getElementById('translate-target-row')),
  translateInto: /** @type {HTMLSelectElement} */ (document.getElementById('translate-into')),
  swap: /** @type {HTMLButtonElement} */ (document.getElementById('swap')),
  list: /** @type {HTMLSelectElement} */ (document.getElementById('list')),
  threshold: /** @type {HTMLSelectElement} */ (document.getElementById('threshold')),
  viewMode: /** @type {HTMLSelectElement} */ (document.getElementById('view-mode')),
  layout: /** @type {HTMLSelectElement} */ (document.getElementById('layout')),
  fontSize: /** @type {HTMLInputElement} */ (document.getElementById('font-size')),
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
  /** Whether the highlighted line is actually being spoken, or is a held gap. */
  speaking: true,
  /** Whether that held line was speaking or a gap, for the rebuild restore. */
  lastSpeaking: true,
  /** What each line was machine-translated into, if anything, for the MT tags. */
  studyTranslation: null,
  glossTranslation: null,
  /** The last state received, so a row tag can name the target language. */
  state: null,
  /**
   * The last cue the worker reported, kept across a row rebuild.
   *
   * Rebuilding the rows resets the highlight, and the state push that caused the
   * rebuild carries the cue anyway — but only when the cue CHANGED. On a refresh
   * or a language switch it has not, so the highlight and the scroll position
   * were both lost until the next cue boundary arrived, which on a paused video
   * is never.
   */
  lastActive: -1,
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
      if (message.state?.activeIndex >= 0) {
        setActive(message.state.activeIndex, !message.state.activePaused);
      }
      return;
    }
    if (message.type === MSG.POSITION) {
      if (message.index < view.rows.length) setActive(message.index, !message.paused);
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
  // Kept so row tags and the status line can name a language they only know
  // about from the state that is currently on screen.
  view.state = state;
  view.studyTranslation = state.studyTranslation ?? null;
  view.glossTranslation = state.glossTranslation ?? null;
  renderPickers(state);
  renderLearning(state);
  renderStatus(state);
  renderRows(state);
}

/** @param {object} state */
function renderPickers(state) {
  const tracks = state.trackList ?? [];

  fillSelect(els.study, tracks, state.study, 'Subtitle');
  // "Off" first, so a second line is opt-in rather than a surprise.
  fillSelect(els.gloss, tracks, state.gloss, 'Off', { includeNone: true });

  // Either line can be translated, independently. Each has its own checkbox beside
  // its picker, and they share the one target below.
  //
  // A checkbox is disabled when its line's track cannot take a translation — or
  // when there is no line on that side at all — and says why on hover, rather than
  // letting the learner tick it and see nothing happen.
  const translatable = (language) =>
    Boolean(language) && (state.translationAvailable ?? {})[language] !== false;

  const studyOk = translatable(state.study);
  // `checked` is only written when it differs. Assigning unconditionally is what
  // broke a real interaction: a state push arriving between a click and its
  // confirmation reset the box, so the click appeared to do nothing and the
  // setting was never sent. A checkbox the user is touching is theirs until the
  // worker contradicts it.
  if (els.studyTranslated.checked !== Boolean(state.studyTranslated)) {
    els.studyTranslated.checked = Boolean(state.studyTranslated);
  }
  els.studyTranslated.disabled = !studyOk;
  els.studyTranslated.title = !state.study
    ? 'No subtitle selected'
    : studyOk
      ? 'Replace this line with a machine translation'
      : 'This caption track cannot be auto-translated';

  const glossOk = translatable(state.gloss);
  if (els.glossTranslated.checked !== Boolean(state.glossTranslated)) {
    els.glossTranslated.checked = Boolean(state.glossTranslated);
  }
  els.glossTranslated.disabled = !glossOk;
  els.glossTranslated.title = !state.gloss
    ? 'No second line selected'
    : glossOk
      ? 'Replace this line with a machine translation'
      : 'This caption track cannot be auto-translated';

  // The target is only shown when something is asking to be translated: with both
  // boxes clear there is no target to choose, and a permanently visible language
  // list is one more control competing with the transcript.
  const wanted = Boolean(state.studyTranslated || state.glossTranslated);
  // Only offer targets a track can actually take. YouTube offers auto-translate
  // for any video, but applying it to a human-authored track silently returns the
  // ORIGINAL text — so offering it would produce a menu that appears to work and
  // changes nothing.
  //
  // Both languages in use are excluded, since translating either into itself is a
  // no-op that looks like a working menu entry.
  const excluded = new Set([state.study, state.gloss].filter(Boolean));
  const options = (state.translationLanguages ?? [])
    .filter((l) => !excluded.has(l.languageCode))
    .map((l) => ({ value: l.languageCode, label: l.name }));

  const usable = wanted && (studyOk || glossOk);
  els.translateTargetRow.hidden = !usable;
  if (usable) {
    fillSelectOptions(els.translateInto, options, state.translateInto, 'Choose a language', {
      disabled: !options.length,
    });
    els.translateInto.title = options.length
      ? 'Language to translate into'
      : 'Neither line can be auto-translated';
  }

  els.swap.disabled = !state.gloss;
  els.swap.title = state.gloss
    ? 'Swap the two lines'
    : 'No second line selected';
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

/**
 * A short readable name for a language code, for the status line.
 *
 * Both lists are consulted because a translation target is often not a track on
 * the video at all — "en" may only exist as something to translate into, and
 * looking in the track list alone would print the bare code.
 *
 * @param {object} state
 * @param {string} code
 * @returns {string}
 */
function shortName(state, code) {
  const found =
    state.translationLanguages?.find((l) => l.languageCode === code) ??
    state.trackList?.find((t) => t.languageCode === code);
  // First word only: YouTube's names carry parentheticals like
  // "Chinese (Traditional)" that would crowd the status line.
  return (found?.name ?? code).split(' (')[0];
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
  // Say what is actually on screen, including a translation that is in effect.
  // Without the arrow a translated line reads as a real track in that language,
  // which is a materially different thing to be looking at.
  const study = state.study
    ? state.studyTranslation
      ? `${shortName(state, state.study)}→${shortName(state, state.studyTranslation)}`
      : shortName(state, state.study)
    : null;
  const gloss = state.gloss
    ? state.glossTranslation
      ? `${shortName(state, state.gloss)}→${shortName(state, state.glossTranslation)}`
      : shortName(state, state.gloss)
    : null;
  const langs = [study, gloss].filter(Boolean).join(' + ');
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

  fillSelectOptions(els.viewMode, VIEW_OPTIONS, learning.view, 'Full');

  if (els.layout) {
    fillSelectOptions(els.layout, optionsFor('layout'), learning.layout, 'Full');
    applyLayout(learning.layout);
  }

  // Bounds come from the schema rather than being repeated in the HTML, so the
  // control cannot offer a range the worker would clamp away.
  const size = definition('fontSize');
  if (size) {
    els.fontSize.min = String(size.min);
    els.fontSize.max = String(size.max);
  }
  // Rebuilt only when it differs, so typing a size does not fight the user by
  // resetting the field mid-edit.
  const sizeValue = String(learning.fontSize ?? '');
  if (document.activeElement !== els.fontSize && els.fontSize.value !== sizeValue) {
    els.fontSize.value = sizeValue;
  }

  // Applied here rather than round-tripped through the worker: text size and the
  // focus view are pure presentation, so sending them anywhere would be a
  // message that changes nothing on the other side.
  applyFontSize(learning.fontSize);
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
function fillSelectOptions(select, options, selected, placeholder, { leading = null, disabled = null } = {}) {
  // `disabled` is part of the signature, not just the options.
  //
  // It used not to be, and that was a real bug the moment a control gated
  // another: ticking the translate box with no target chosen must ENABLE the
  // picker, and with the same (empty) option list the signature matched, the
  // control was left alone, and it stayed disabled forever.
  const signature =
    (leading ? `lead:${leading.value}:${leading.label}|` : '') +
    options.map((option) => `${option.value}:${option.label}`).join(',') +
    `|${selected}|${disabled ?? 'auto'}`;
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;

  select.replaceChildren();
  if (!options.length) {
    select.append(new Option(placeholder, ''));
    select.disabled = disabled ?? true;
    return;
  }

  // The "back to the original" entry, when the caller wants one.
  if (leading) select.append(new Option(leading.label, leading.value));

  select.disabled = disabled ?? false;
  for (const option of options) {
    const element = new Option(option.label, String(option.value));
    // An empty `selected` means the original, which the leading option covers.
    element.selected = String(option.value) === String(selected ?? '');
    select.append(element);
  }
}

/**
 * A text size as a number in range, from a control or from storage.
 *
 * Empty is not zero. `Number('')` is 0, which clamps to the 10px minimum — so
 * clearing the field would shrink the text as a side effect, which is not what a
 * person clearing a field means. An empty or unparseable value falls back to the
 * default instead.
 *
 * Bounds come from the schema rather than being repeated as literals: the worker
 * clamps against the same definition, and two copies of "10..32" eventually
 * disagree.
 *
 * @param {string|number|null|undefined} raw
 * @returns {number}
 */
function sizeFrom(raw) {
  const { min, max, default: fallback } = definition('fontSize');
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '' || text === null || text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Text size is a single pixel size on the root element.
 *
 * Every other size in the stylesheet is expressed as a multiple of it, because
 * the alternative — one variable holding a size that other rules override —
 * cannot move nine separate sizes together.
 *
 * A px number rather than a preset or a multiplier: "18px" is what the browser's
 * own zoom and font settings speak, and it needs no arithmetic against a base
 * the reader would have to go and look up.
 *
 * @param {number} pixels
 */
function applyFontSize(pixels) {
  document.documentElement.style.setProperty('--font-size', `${sizeFrom(pixels)}px`);
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
  // ...and when there is no current line to reveal, nothing would be shown at
  // all: the focus view hides every row except `.active` and `.next`, and both are
  // decided by playback. On a fresh panel — or a paused video, where the worker
  // may have sent no cue yet — that is an entirely blank panel, which is what
  // "Live mode is blank" was. Highlighting the first row is the honest fallback:
  // the transcript has to start somewhere, and starting at the top is what the
  // Full view does too.
  if (view.focusMode && view.activeIndex < 0 && view.elements.length) setActive(0);
}

/**
 * How much of the panel's chrome is on screen.
 *
 * A class on the body rather than re-rendering, so switching is instant and no
 * control loses its value. `collapsed` hides the reading controls and the status
 * line, leaving the language row and the transcript — a side panel is around
 * 600px tall on a laptop, and three bars plus a status line is a large fraction
 * of that.
 *
 * @param {string} mode
 */
function applyLayout(mode) {
  // `body` is not guaranteed: the audio path and the DOM stubs used by the tests
  // both construct a document without one. Guarded rather than assumed, because an
  // unguarded dereference here threw during the FIRST state render and took the
  // whole panel down — no rows, no status, just the panel's error placeholder.
  document.body?.classList.toggle('collapsed', mode === 'collapsed');
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

els.study.addEventListener('change', () => {
  send({ type: MSG.SET_STUDY, languageCode: els.study.value });
});

els.gloss.addEventListener('change', () => {
  send({ type: MSG.SET_GLOSS, languageCode: els.gloss.value || null });
});

// The tick and the target are two halves of one choice: ticking either box must
// tell the worker what to aim at, so they share a handler.
els.studyTranslated.addEventListener('change', () => {
  send({ type: MSG.SET_SETTING, id: 'studyTranslated', value: els.studyTranslated.checked });
});

els.glossTranslated.addEventListener('change', () => {
  send({ type: MSG.SET_SETTING, id: 'glossTranslated', value: els.glossTranslated.checked });
});

els.translateInto.addEventListener('change', () => {
  send({ type: MSG.SET_SETTING, id: 'translateInto', value: els.translateInto.value || null });
});

els.layout.addEventListener('change', () => {
  applyLayout(els.layout.value);
  send({ type: MSG.SET_SETTING, id: 'layout', value: els.layout.value });
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

// Only a complete, in-range value is applied live. Typing "18" passes through
// "1", and applying that immediately clamped to 10 and re-rendered the whole
// transcript mid-keystroke — the field fighting the person typing in it. An
// empty field is the same case: it is a value being typed, not a value, and
// treating it as one would snap the size on every backspace.
els.fontSize.addEventListener('input', () => {
  const size = definition('fontSize');
  const value = Number(els.fontSize.value);
  if (!els.fontSize.value.trim() || !Number.isFinite(value)) return;
  if (value < size.min || value > size.max) return;
  applyFontSize(value);
});

// Committed on change rather than on every keystroke, so a half-typed "1" in
// "18" is not stored as the size you asked for. The worker clamps too, so a
// nonsense value cannot reach the stylesheet.
els.fontSize.addEventListener('change', () => {
  const value = sizeFrom(els.fontSize.value);
  applyFontSize(value);
  // Written back explicitly, because the live handler above deliberately leaves
  // an out-of-range or empty field alone and the browser does not rewrite it
  // either — so "999" would otherwise sit on screen looking accepted while the
  // panel showed 32.
  els.fontSize.value = String(value);
  send({ type: MSG.SET_SETTING, id: 'fontSize', value });
});

els.swap.addEventListener('click', () => {
  const study = els.study.value;
  const gloss = els.gloss.value;
  if (!gloss) return;

  // Swapping changes which line is being learned. The translation does NOT swap
  // with it, and must not: it is a property of the gloss line, and the study line
  // is never translated. Carrying it across would put a machine translation on
  // the line whose marks and definitions describe different text.
  send({ type: MSG.SET_STUDY, languageCode: gloss });
  send({ type: MSG.SET_GLOSS, languageCode: study || null });
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
  if (rows === view.rows && state.study === view.renderedStudy) return;

  view.rows = rows;
  view.renderedStudy = state.study;
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

  // Rebuilding cleared the highlight, so put it back from the last cue we were
  // told about. Without this a refresh — which rebuilds the rows without the cue
  // changing — left the transcript scrolled to the top and nothing highlighted,
  // and on a paused video it stayed that way.
  if (view.lastActive >= 0) {
    setActive(view.lastActive, view.lastSpeaking);
  }
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

  // The study line. Machine output when this line is the one translated — the tag
  // belongs to whichever line is machine text, not to the second one by position.
  const study = document.createElement('span');
  study.className = 'primary';

  // Tokens arrive from the worker once the word list has loaded, which is not
  // necessarily by the time the transcript does. Until then the line renders as
  // plain text, so the transcript is never withheld waiting on the dictionary.
  if (row.tokens) {
    study.append(renderTokens(row.tokens, view.levelCount, view.palette));
  } else {
    study.textContent = row.text;
  }
  if (view.studyTranslation) {
    const tag = document.createElement('span');
    tag.className = 'machine';
    tag.textContent = 'MT';
    tag.title = `Machine-translated into ${shortName(view.state ?? {}, view.studyTranslation)}`;
    study.append(tag);
  }
  lines.append(study);

  // The gloss. Marked when it is machine output rather than a real track: a
  // translated line is not a transcript, and machine translation of Chinese
  // paraphrases rather than glosses — so it should not read as a human
  // translation of the spoken words. Only this line can be machine output, so
  // the tag does not have to say which line it belongs to.
  if (row.secondary) {
    const gloss = document.createElement('span');
    gloss.className = 'secondary';
    gloss.textContent = row.secondary;
    if (view.glossTranslation) {
      const tag = document.createElement('span');
      tag.className = 'machine';
      tag.textContent = 'MT';
      tag.title = `Machine-translated into ${shortName(view.state ?? {}, view.glossTranslation)}`;
      gloss.append(tag);
    }
    lines.append(gloss);
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

/**
 * Highlight a row, including the case where nothing is being spoken.
 *
 * `index` is the last cue that has STARTED, which is not the same as a cue being
 * in progress: between two lines there is a gap, and during it the honest answer
 * is "the line that finished". Returning -1 for those gaps — which is what the
 * worker used to do — made the highlight blink off after every line and blank
 * the Live view entirely, since it filters to the active row.
 *
 * @param {number} index
 * @param {boolean} [speaking] False in a gap between lines.
 */
function setActive(index, speaking = true) {
  if (index === view.activeIndex && speaking === view.speaking) return;

  // Remembered so a later row rebuild can restore it. Kept here rather than in
  // the message handler so every path that moves the highlight updates it.
  view.lastActive = index;
  view.lastSpeaking = speaking;

  view.elements[view.activeIndex]?.classList.remove('active');
  // The previous successor is no longer the successor.
  view.elements[view.activeIndex + 1]?.classList.remove('next');
  // Clear the dim from whichever row had it, so a gap state cannot outlive the
  // gap it described.
  for (const element of view.elements) element.classList.remove('paused');

  view.activeIndex = index;
  view.speaking = speaking;
  if (index < 0) return;

  const element = view.elements[index];
  if (!element) return;
  element.classList.add('active');
  // Not being spoken, but still the last line: dimmed rather than gone, so a
  // reader looking up mid-gap keeps their place.
  if (!speaking) element.classList.add('paused');

  // The next line is marked so the Live view can reveal it as a preview. The
  // class is applied in both views because it costs nothing and switching views
  // should not need a re-render to become correct.
  view.elements[index + 1]?.classList.add('next');

  if (!view.autoScroll) return;
  // In Live view the line is centred, because the preview sits below it and
  // scrolling to the edge would push it off screen.
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
  // Hiding the language controls and the translate target, since the audio path
  // has no caption tracks to choose between.
  els.study.hidden = true;
  els.gloss.hidden = true;
  els.studyTranslated.hidden = true;
  els.glossTranslated.hidden = true;
  els.translateTargetRow.hidden = true;
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
