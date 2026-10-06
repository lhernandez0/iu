/**
 * Service worker — owns the transcript table. Nothing else does.
 *
 * The panel is a subscriber that renders whatever it is sent; content scripts
 * are stateless fetch providers. Putting the table here is what makes the panel
 * survive tab switches: switching tabs does not destroy the worker, and the
 * panel's open port keeps it alive, so every video visited stays cached and
 * swapping back is instant.
 *
 * Why the worker and not the panel: a panel document is torn down when it is
 * closed or its tab closes, taking any cache with it. The worker also already
 * has to talk to content scripts, so routing through it removes the panel's
 * need to know about tab ids, frames, or track state at all.
 *
 * Also here, parked: the tab-capture session (startCapture/stopCapture), which
 * mints the stream id a service worker is required to produce.
 */

import { MSG, TARGET } from '../common/messages.js';
import { errorText, codeError } from '../common/errors.js';
import { alignSecondary } from '../common/transcript.js';
import { defaults, normalise, toStorage, storageKey, definition } from '../common/settings.js';
import { providerFor, providerNames } from '../common/providers.js';
import { loadDictionary, loadIndex, dictionaryPathFor, levelOf, lookup, INDEX_PATH } from '../learn/wordlist.js';
import { segmentSegments } from '../learn/segment.js';

/**
 * The list manifest URL, and the dictionary URL for its active list.
 *
 * Resolved here, not inside `learn/wordlist.js`. That module is about data and
 * does not know whether it is running in a browser; taking the URL as an argument
 * is what makes it testable without a `chrome` stub, and reusable outside an
 * extension at all.
 *
 * @returns {string}
 */
function indexUrl() {
  return chrome.runtime.getURL(INDEX_PATH);
}

/** How many videos to keep transcripts for before evicting the oldest. */
const MAX_CACHED_VIDEOS = 6;
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/**
 * @typedef {Object} VideoEntry
 * @property {string} videoId
 * @property {string} title
 * @property {boolean} isLive
 * @property {object[]} trackList            Available tracks, as offered to the panel.
 * @property {boolean} stale                 The page could not report its tracks.
 * @property {string|null} studyLang
 * @property {string|null} glossLang
 * @property {Map<string, object[]>} tracks  languageCode -> segments.
 * @property {object[]} rows                 Primary segments, with tokens where marked.
 * @property {string|null} error
 * @property {string|null} [markedWith]      `listId:threshold` the rows were marked for.
 */

/** @type {Map<string, VideoEntry>} videoId -> entry. Insertion order doubles as eviction order. */
const videos = new Map();

/**
 * Every learner preference, held as one object.
 *
 * Settings live here rather than as a field each because they are already
 * interdependent — the threshold is meaningless without the word list, and the
 * word list is meaningless without the dictionary loaded — so keeping them
 * together is what lets them be normalised, persisted and sent as a unit.
 *
 * Language choices are settings too, which is what makes them sticky: they are
 * the preferred default for the next video, not merely an assignment to the
 * current one.
 *
 * @type {Record<string, any>}
 */
let settings = defaults();

/**
 * Resolves once the stored settings have been read.
 *
 * The first refresh is what seeds a video's language choices, and it can be
 * triggered the moment a panel connects — which is before an async storage read
 * has finished. Without waiting, the restored choice loses the race and the first
 * video of every session comes up in the default language, which looks exactly
 * like the setting not persisting at all.
 *
 * @type {Promise<void>}
 */
let settingsReady = Promise.resolve();

/** @type {number|null} Tab whose video the panel is showing. */
let trackedTabId = null;

/** @type {string|null} */
let currentVideoId = null;

/**
 * The panel's port. A connected port keeps the worker alive, which is what
 * preserves the cache while the panel is open.
 *
 * Note the split: requests arrive on this port, but content-script reports
 * arrive on chrome.runtime.onMessage. Port messages do NOT reach onMessage —
 * they are two separate channels — which is why the panel's own reply(add
 * refresh) is handled here rather than in the switch below.
 *
 * @type {chrome.runtime.Port|null}
 */
let panelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  panelPort = port;

  const onMessage = (message) => handlePanelMessage(message);
  port.onMessage.addListener(onMessage);

  port.onDisconnect.addListener(() => {
    port.onMessage.removeListener(onMessage);
    if (panelPort === port) panelPort = null;
  });

  // A fresh panel has nothing to render, so resolve the current tab now. The
  // panel relies on this rather than asking itself, so there is one inbound
  // path for state.
  void refresh();
});

/** @param {object} message */
function handlePanelMessage(message) {
  if (!message || message.target !== TARGET.BACKGROUND) return;

  switch (message.type) {
    case MSG.REFRESH:
      void refresh();
      return;
    case MSG.SET_STUDY:
      void chooseTrack('study', message.languageCode);
      return;
    case MSG.SET_GLOSS:
      void chooseTrack('gloss', message.languageCode);
      return;
    case MSG.SEEK:
      void forwardSeek(message.seconds);
      return;

    // --- Learning layer ------------------------------------------------------
    case MSG.SET_LIST:
      settings.listId = message.listId;
      // Take the new list's own default rather than carrying a threshold from a
      // list with a different number of levels, where it would mean something
      // else entirely.
      settings.threshold = defaultThreshold(listById(message.listId));
      persistSettings();
      // Rows are rebuilt because switching lists can change which levels exist,
      // so the existing marks are no longer valid.
      //
      // The dictionary for the new list's language is awaited FIRST, because a
      // switch can cross languages (HSK → JLPT) and `rebuildRows` reads the
      // dictionary synchronously. Broadcasting before the words arrive would
      // paint an unmarked transcript and leave it that way until something else
      // happened to rebuild.
      void ensureDictionaryFor(message.listId).then(() => {
        rebuildRows(currentEntry());
        broadcastState();
      });
      return;

    case MSG.SET_THRESHOLD:
      settings.threshold = Number(message.threshold);
      persistSettings();
      rebuildRows(currentEntry());
      broadcastState();
      return;

    case MSG.SET_SETTING:
      void applySetting(message.id, message.value);
      return;

    case MSG.LOOKUP:
      void answerLookup(message.word);
      return;

    default:
      // Anything else from the panel is ignored rather than thrown on.
      return;
  }
}

/**
 * The level a list should mark from, if the learner has not chosen one.
 *
 * Read from the LIST, not inferred from its id.
 *
 * This used to be `listId.startsWith('hsk') ? 4 : 1`, which hardcoded both a
 * language and a standard into the worker: a JLPT or HSK 4.0 list would silently
 * start at 1 and look broken. The starting level is a property of the list — only
 * the data knows where a learner with that list is likely to be — so it travels
 * with the list like `levelCount` does.
 *
 * Clamped by the caller to the list's own range, because a threshold only means
 * something relative to the list it applies to.
 *
 * @param {object|undefined} list
 * @returns {number}
 */
function defaultThreshold(list) {
  const level = Number(list?.defaultThreshold);
  return Number.isFinite(level) && level >= 1 ? Math.min(level, list.levelCount ?? level) : 1;
}

/**
 * A word list by id, or the first available.
 *
 * Resolved from `availableLists` rather than passed around, because the two
 * settings that need it — which list, and what threshold within it — are changed
 * from different places and each has to look the list up from the id it stored.
 *
 * @param {string|null|undefined} listId
 * @returns {object|undefined}
 */
function listById(listId) {
  return availableLists.find((list) => list.id === listId) ?? availableLists[0];
}

/**
 * Where playback currently is, as a cue index.
 *
 * Held here because POSITION from the content script is an *event*: it fires
 * once per cue change and the content script dedupes on it. A panel opened
 * afterwards would therefore never hear about the cue that is already playing,
 * and would sit at the top of the transcript with Follow ticked doing nothing.
 * Keeping it makes position part of the state, so it can be sent on connect
 * along with everything else.
 *
 * @type {number}
 */
let activeIndex = -1;

/**
 * Whether the highlighted cue sits in a gap between two lines.
 *
 * Cue times do not tile the timeline — a line ends and the next starts a moment
 * later — so for a fraction of a second after every line nothing is being said.
 * The panel dims rather than dropping the highlight, and this is what tells it
 * which. Kept beside the index because the two always travel together.
 *
 * @type {boolean}
 */
let activePaused = false;

/** @type {string|null} */
let pendingError = null;

/**
 * A translation that could not be produced, kept apart from the transcript.
 *
 * `entry.error` replaces the whole transcript on screen and blocks the cache, so
 * a failed second line must not go there — the first line is already correct and
 * readable. This clears as soon as a translation succeeds.
 *
 * @type {string|null}
 */
let translationError = null;

/**
 * The word lists offered to the panel. Empty until the index loads, which is why
 * the panel has to tolerate an empty list rather than assume one.
 *
 * @type {object[]}
 */
let availableLists = [];

/**
 * The list manifest, loaded once at startup. Names every list and which
 * dictionary holds its words.
 *
 * @type {{dictionaries: Record<string, string>, lists: object[]}|null}
 */
let listIndex = null;

/**
 * The dictionary for the ACTIVE language. Loaded lazily — see
 * `ensureDictionaryFor` — and null until then.
 *
 * @type {object|null}
 */
let dictionary = null;

/** Which language `dictionary` holds, so a list switch knows when to reload. */
let dictionaryLanguage = null;

/**
 * Make `dictionary` hold the given list's language.
 *
 * A no-op when it already does, so this is safe to call on every rebuild. Called
 * from three places — startup, a list change, and a hover lookup — because any of
 * them can be the first to need words and a missed one shows as a lookup that
 * silently returns nothing.
 *
 * @param {string|null|undefined} listId
 * @returns {Promise<object|null>}
 */
async function ensureDictionaryFor(listId) {
  const list = listById(listId);
  const language = list?.language ?? 'zh';
  if (dictionary && dictionaryLanguage === language) return dictionary;

  const path = listIndex?.dictionaries?.[language] ?? listIndex?.dictionaries?.zh;
  if (!path) return dictionary;

  dictionary = await loadDictionary(chrome.runtime.getURL(path));
  dictionaryLanguage = language;
  return dictionary;
}

/** @type {{tabId: number, streamId: string, tabTitle: string}|null} */
let session = null;

// --- Message routing --------------------------------------------------------

// Both the panel and content scripts address the worker, but on different
// channels: the panel uses its port (see handlePanelMessage above), content
// scripts use chrome.runtime.sendMessage and land here. Panel intents that
// arrive here anyway — the parked capture control below — are handled too, so
// the capture path keeps working whether or not a port is connected.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== TARGET.BACKGROUND) return false;

  switch (message.type) {
    // --- From content scripts ------------------------------------------------
    case MSG.CONTENT_POSITION:
      // Only trusted from the tab the panel is actually showing. A background
      // YouTube tab also reports playback, and its cues are meaningless for the
      // transcript on screen. `sender` is the only way to tell them apart.
      if (sender?.tab?.id !== trackedTabId) return false;

      // Remembered even with no panel attached, so opening one mid-video can
      // start at the live cue rather than at the top of the transcript.
      //
      // `paused` travels with it because the index alone cannot say whether that
      // line is being spoken or is the line that just finished — those are
      // different states on screen, and only the content script knows which.
      activeIndex = message.index;
      activePaused = Boolean(message.paused);
      panelPort?.postMessage({
        type: MSG.POSITION,
        index: message.index,
        seconds: message.seconds,
        paused: activePaused,
      });
      return false;

    case MSG.CONTENT_VIDEO_CHANGED:
      void onContentVideoChanged(sender?.tab?.id ?? null);
      return false;

    // --- Parked capture control ----------------------------------------------
    case MSG.START_CAPTURE:
      startCapture(message)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case MSG.STOP_CAPTURE:
      stopCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case MSG.SET_MONITOR_MUTED:
      // Parked: pure forward, the offscreen document owns the audio element.
      chrome.runtime
        .sendMessage({ type: MSG.SET_MONITOR_MUTED, target: TARGET.OFFSCREEN, muted: message.muted })
        .catch(() => {});
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

/** Push the whole table to the panel. */
function broadcastState() {
  panelPort?.postMessage({ type: MSG.STATE, state: deriveState() });
}

/**
 * Answer a hover with the definition and the levels this word carries.
 *
 * The dictionary is asked even when the word has no level, because a word
 * outside the graded lists is exactly the case the learner may not know and
 * would want defined. Absent level is not absent meaning.
 *
 * `levels` is always an array, never null, even when there is no definition:
 * the two are independent axes, and a caller should not have to distinguish
 * "no levels" from "we did not look".
 *
 * @param {string} word
 */
async function answerLookup(word) {
  if (!panelPort || !word) return;
  try {
    // The dictionary for the active language, awaited because a hover can arrive
    // before anything has marked a row — and a lookup that returned nothing for
    // that reason would read as "this word has no definition".
    const entry = currentEntry();
    const active = await ensureDictionaryFor(effectiveListId(entry));
    if (!active) return;
    panelPort.postMessage({
      type: MSG.ENTRY,
      word,
      entry: lookup(active, word),
      levels: levelsFor(active, word),
      listId: effectiveListId(entry),
    });
  } catch (error) {
    broadcastError(errorText('DICT002', String(error?.message ?? error)));
  }
}

/**
 * Every list that places this word, so hover can show them all rather than only
 * the selected one — a word is HSK 4 in 2.0 and HSK 6 in 3.0, and both are true.
 *
 * @param {object} dictionary
 * @param {string} word
 * @returns {Array<{id: string, label: string, level: number, levelCount: number}>}
 */
function levelsFor(dictionary, word) {
  const out = [];
  for (const list of dictionary.lists) {
    const level = levelOf(dictionary, list.id, word);
    if (level !== null) {
      out.push({ id: list.id, label: list.label, level, levelCount: list.levelCount });
    }
  }
  return out;
}

/** @param {string} message */
function broadcastError(message) {
  panelPort?.postMessage({ type: MSG.ERROR, error: message });
}

// --- Tab tracking -----------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void onTabActivated(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (trackedTabId === tabId) trackedTabId = null;
  if (session?.tabId === tabId) void stopCapture();
});

/**
 * Keep up with the user. Tabs we cannot read are ignored rather than clearing the
 * panel, so glancing at another tab and coming back does not lose your place.
 *
 * @param {number} tabId
 */
async function onTabActivated(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !providerFor(tab.url)) return;
  trackedTabId = tabId;
  await refresh();
}

/**
 * A content script says the video in its tab changed.
 *
 * The reporting tab matters. A tab in the background also notices when its video
 * changes, and following that would drag the panel away from what the user is
 * looking at. So the change is only honoured when the tab reporting it is the
 * active one — which is the same rule the rest of this file follows: whatever is
 * in the current tab is what the panel shows.
 *
 * @param {number|null} tabId The tab that reported, from the message sender.
 */
async function onContentVideoChanged(tabId) {
  if (tabId === null) return;

  if (tabId !== trackedTabId) {
    // Adopt it only if it is the tab the user is actually on.
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== tabId) return;
  }

  trackedTabId = tabId;
  const before = currentVideoId;
  await refresh();
  if (currentVideoId !== before) broadcastState();
}

// --- Resolving the current video --------------------------------------------

/**
 * Frames we have already injected into, as `tabId:frameId`.
 *
 * `executeScript` re-runs the file every time it is called, and both content
 * scripts are called on every round trip — so without this, one refresh would
 * inject four times. The scripts' own re-entry guards make that harmless, but it
 * is still work: the file is fetched, compiled and evaluated each time.
 *
 * Cleared when a frame navigates, because a real page load discards the scripts
 * and they have to be put back.
 *
 * @type {Set<string>}
 */
const injectedFrames = new Set();

/** @param {number} tabId @param {number} frameId */
const frameKey = (tabId, frameId) => `${tabId}:${frameId}`;

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  // A committed navigation destroys the page's scripts, so allow reinjection.
  injectedFrames.delete(frameKey(tabId, frameId));
});

/**
 * Find the frame holding the video and make sure the provider's scripts are
 * running in it.
 *
 * The video is not always in the tab's top frame, so injecting blindly is not
 * safe. `webNavigation.getAllFrames` tells us which frame is a document the
 * provider recognises.
 *
 * The bridge is injected first and always, because it is what the content
 * script talks to, and on a tab that was already open when the extension loaded
 * the manifest-declared scripts are absent too — so without injecting both,
 * every request would come back empty.
 *
 * @param {number} tabId
 * @returns {Promise<number|null>} frameId, or null if there is no such frame.
 */
async function ensureContentScript(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (!frames?.length) return null;

  const frame =
    frames.find((f) => f.frameId === 0 && providerFor(f.url)) ??
    frames.find((f) => providerFor(f.url));
  if (!frame) return null;

  if (injectedFrames.has(frameKey(tabId, frame.frameId))) return frame.frameId;

  const provider = providerFor(frame.url);
  if (!provider) return null;

  const target = { tabId, frameIds: [frame.frameId] };
  try {
    for (const file of provider.bridgeFiles) {
      await chrome.scripting.executeScript({ target, world: 'MAIN', files: [file] });
    }
    for (const file of provider.contentFiles) {
      await chrome.scripting.executeScript({ target, files: [file] });
    }
    injectedFrames.add(frameKey(tabId, frame.frameId));
  } catch {
    // The page refuses injection (a chrome:// page, say). Leave it unmarked so a
    // later attempt can try again rather than being permanently skipped.
  }
  return frame.frameId;
}

/** How long to wait for a content script before giving up on it. Without this
 *  a missing or wedged script leaves refresh() pending forever, and the panel
 *  shows nothing at all — which reads as "broken", with no clue why. */
const CONTENT_TIMEOUT_MS = 4000;

/**
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<any>}
 */
async function sendToContent(tabId, message) {
  const frameId = await ensureContentScript(tabId);
  if (frameId === null) throw new Error(errorText('CONN001'));

  let timer = 0;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, { ...message, target: TARGET.CONTENT }, { frameId }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(errorText('CONN002', `${message.type} did not answer within ${CONTENT_TIMEOUT_MS}ms`))),
          CONTENT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-read the active tab and rebuild the current video's entry.
 *
 * Wrapped so that ANY failure ends in a broadcast. A refresh that throws before
 * broadcasting leaves the panel on its placeholder indefinitely, which is
 * indistinguishable from the extension not being installed.
 *
 * @returns {Promise<void>}
 */
async function refresh() {
  // Nothing here is correct without the settings: which language to load, which
  // word list to mark with. Waiting is cheap after the first read, because the
  // promise is already resolved.
  await settingsReady;
  try {
    await refreshInner();
  } catch (error) {
    pendingError = codeError('CONN004', error);
    broadcastState();
  }
}

/** @returns {Promise<void>} */
async function refreshInner() {
  if (trackedTabId !== null) {
    // A tracked tab can be closed or navigated away since we last looked.
    const alive = await chrome.tabs.get(trackedTabId).catch(() => null);
    if (!alive || !providerFor(alive.url)) trackedTabId = null;
  }

  if (trackedTabId === null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !providerFor(tab.url)) {
      pendingError = errorText('CONN005', providerNames());
      broadcastState();
      return;
    }
    trackedTabId = tab.id;
  }

  // Ask what this tab is showing BEFORE deciding anything. Acting on a stale
  // `currentVideoId` was what let the panel keep the previous video's transcript
  // after an in-tab switch.
  //
  // DESCRIBE rather than PROVIDE on purpose: describing is free, and if the
  // video is already cached there is no reason to make the content script
  // download a track we already hold.
  let described;
  try {
    described = await sendToContent(trackedTabId, { type: MSG.DESCRIBE });
  } catch (error) {
    // Pass-through: `sendToContent` already raised a CONN code and that one
    // names the real fault (a timeout, say) better than this layer can.
    pendingError = codeError('CONN003', error);
    broadcastState();
    return;
  }

  if (!described?.video) {
    pendingError = described?.error ?? errorText('CONN004');
    broadcastState();
    return;
  }

  pendingError = null;
  const entry = adoptVideo(described.video);

  // A position travelling with the description lets a mid-video open land on the
  // current line. It arrives as a number only when the content script already
  // holds segments; otherwise the next position tick supplies it.
  if (typeof described.video.activeIndex === 'number' && described.video.activeIndex >= 0) {
    activeIndex = described.video.activeIndex;
    activePaused = Boolean(described.video.activePaused);
  }

  // Nothing to fetch and nothing to show: say so rather than leaving the panel
  // on an empty transcript with no explanation.
  //
  // An empty list only means that when the page could actually report its
  // tracks. If the page was stale it simply could not tell us, and the captions
  // are still worth asking the player API for.
  if (!entry.trackList.length && !entry.stale) {
    entry.error = errorText('VIDEO001');
    entry.rows = [];
    broadcastState();
    return;
  }

  // Already in hand: this is what makes swapping between YouTube tabs instant,
  // and what keeps a video's transcript alive while you look at others.
  if (isCached(entry)) {
    rebuildRows(entry);
    // Hand the transcript over before saying anything. The content script keys
    // its position reporting off the segments it holds, and nothing was fetched,
    // so without this a freshly loaded page — or a panel opened after a reload —
    // reports no cue at all and the panel never learns where playback is.
    void primeContentPosition(entry);
    broadcastState();
    return;
  }

  // A cache miss, so pay for a download. The track to load is the one already
  // chosen for this video, or the content script's default when it is new.
  //
  // The translation target travels with the request rather than being applied
  // afterwards, because the provider has to choose a source track that actually
  // supports translation — and it cannot know that from a second round trip.
  //
  // `null` for the study line, always: the line being learned is never machine
  // translated, so the provider is asked for the plain track.
  let provided;
  try {
    provided = await sendToContent(trackedTabId, {
      type: MSG.PROVIDE,
      languageCode: entry.studyLang,
      translateTo: effectiveTranslation(entry, 'study'),
    });
  } catch (error) {
    // Pass-through, so a CONN002 timeout from `sendToContent` survives as itself
    // rather than being relabelled as a caption fault — which is what made this
    // report ambiguous in the first place.
    pendingError = codeError('TRACK003', error);
    broadcastState();
    return;
  }

  if (!provided?.ok && !provided?.fetched) {
    entry.error = provided?.error ?? errorText('TRACK004');
    broadcastState();
    return;
  }

  if (recordTrack(entry, provided.fetched)) {
    entry.studyLang = provided.fetched.languageCode;
  } else if (provided.fetched?.error) {
    // A failed translation must not empty a transcript that loaded fine. The
    // text is already on screen; the error belongs to the line that could not
    // be produced, so it is reported and the rows are left alone.
    const failed = provided.fetched.translateTo === null && suppliedTranslation(provided.fetched);
    if (!failed) entry.error = provided.fetched.error;
    if (failed) translationError = provided.fetched.error;
  }

  rebuildRows(entry);

  // Show the study line immediately, then fill in the gloss.
  //
  // The check is for the GLOSS'S RENDERING, not for its language code. The gloss
  // may be the same language as the study line — that is how you ask for one
  // language with its translation underneath — and a language-code test would
  // see the study line's entry, decide the gloss was already loaded, and leave it
  // showing the study line's text instead of its own rendering.
  const glossKey = entry.glossLang ? trackKey(entry.glossLang, effectiveTranslation(entry, 'gloss')) : null;
  const studyKey = trackKey(entry.studyLang ?? '', effectiveTranslation(entry, 'study'));
  const wantsGloss = Boolean(glossKey) && !entry.tracks.has(glossKey) && glossKey !== studyKey;
  if (wantsGloss) broadcastState();

  if (wantsGloss) {
    const result = await loadTrack(entry, entry.glossLang, effectiveTranslation(entry, 'gloss'));
    // Same rule as the study line: a translation that could not be produced is
    // reported without discarding a gloss line that did.
    if (result?.error) {
      if (result.translateTo === null && suppliedTranslation(result)) translationError = result.error;
      else entry.error = result.error;
    }
    rebuildRows(entry);
  }

  broadcastState();
}

/**
 * Whether a failed result was a translation that never happened.
 *
 * The provider reports `translateTo: null` for BOTH "no translation wanted"
 * and "the translation failed", so the error text is the only thing that
 * separates them. Matching on it is ugly, but the alternative is discarding a
 * working transcript because its second line could not be translated, and that
 * is worse than a string comparison.
 *
 * @param {object} fetched
 * @returns {boolean}
 */
function suppliedTranslation(fetched) {
  return /translat/i.test(String(fetched?.error ?? ''));
}

/**
 * Create or update the cache entry for a video.
 *
 * @param {{videoId: string, title: string, isLive: boolean, trackList: object[]}} video
 * @returns {VideoEntry}
 */
function adoptVideo(video) {
  // The remembered cue belongs to the video that was playing before. Carrying it
  // across would highlight a line of the NEW transcript at an index measured
  // against the old one — off by as much as the two transcripts differ.
  if (currentVideoId !== video.videoId) {
    activeIndex = -1;
    activePaused = false;
  }

  currentVideoId = video.videoId;

  let entry = videos.get(video.videoId);
  if (!entry) {
    entry = {
      videoId: video.videoId,
      title: video.title,
      isLive: video.isLive,
      trackList: video.trackList ?? [],
      translationLanguages: video.translationLanguages ?? [],
      stale: Boolean(video.stale),
      // Both language choices are seeded from the saved preferences, which is
      // what makes them sticky. The study language was previously left null
      // here, so every new video fell back to the content script's own default
      // and a Chinese subtitle choice was silently lost on the next video.
      //
      // A preference that this video cannot satisfy is cleared from the entry
      // below, but never from the settings — so returning to a video that has
      // the language brings it back.
      studyLang: settings.studyLanguage,
      glossLang: settings.glossLanguage,
      tracks: new Map(),
      rows: [],
      error: null,
      markedWith: null,
    };
    videos.set(video.videoId, entry);
    evictOldest();
  } else {
    // Refresh metadata, keep any already-fetched transcripts.
    entry.title = video.title ?? entry.title;
    entry.isLive = video.isLive;
    entry.trackList = video.trackList ?? entry.trackList;
    entry.translationLanguages = video.translationLanguages?.length
      ? video.translationLanguages
      : entry.translationLanguages;
    entry.stale = Boolean(video.stale);
  }

  // Drop any selection whose track no longer exists on this video.
  if (entry.studyLang && !hasTrack(entry, entry.studyLang)) entry.studyLang = null;
  if (entry.glossLang && !hasTrack(entry, entry.glossLang)) entry.glossLang = null;

  return entry;
}

/** @param {VideoEntry} entry @param {string} languageCode */
function hasTrack(entry, languageCode) {
  return entry.trackList.some((t) => t.languageCode === languageCode);
}

/**
 * Whether this video's transcript is already in hand, so no fetch is needed.
 *
 * A video with an error is never considered cached, so the next attempt retries
 * rather than leaving a failure pinned in place.
 *
 * @param {VideoEntry} entry
 * @returns {boolean}
 */
function isCached(entry) {
  if (entry.error) return false;
  if (!entry.studyLang || !entry.rows.length) return false;

  const cached = entry.tracks.get(trackKey(entry.studyLang, effectiveTranslation(entry, 'study')));
  if (!cached) return false;

  // The cached text has to be the rendering now being asked for.
  //
  // A guard rather than a tested path: changing the translation already goes
  // through loadTrack, which compares the same thing. This catches the case
  // where the cache and the wanted rendering diverge WITHOUT that path running —
  // most plausibly a video whose track list stops reporting `isTranslatable`
  // between refreshes, which would otherwise leave translated text on screen
  // while the extension believed the setting no longer applied.
  return cached.translateTo === (effectiveTranslation(entry, 'study') ?? null);
}

/**
 * The translation actually worth asking for, for one ROLE.
 *
 * EITHER line can be translated. Each has its own bit sharing the one target, and
 * the rule is about the LINE, not about which line it is.
 *
 * An earlier version allowed only the gloss, reasoning that the study line is
 * "the text being learned". That conflated two different things — which line
 * carries the learning MARKS, and which line can be TRANSLATED — and forbade a
 * feature for a reason that only applies to the other one. The cases it broke are
 * ordinary: a Chinese-only video where you want the Chinese line translated with
 * the original kept alongside, or an English video where the first line is the one
 * you want naturalised.
 *
 * The rule that does hold is about marks: a machine translation carries NONE,
 * whichever line it is on, because it paraphrases rather than glosses and hides
 * the word boundaries the marks exist to point at. `rebuildRows` enforces that,
 * and it is the reason translating the marked line is safe to allow.
 *
 * @param {VideoEntry} entry
 * @param {'study'|'gloss'} role
 * @returns {string|null}
 */
function effectiveTranslation(entry, role) {
  const wanted = settings.translateInto;
  if (!wanted) return null;

  const on = role === 'study' ? settings.studyTranslated : settings.glossTranslated;
  if (!on) return null;

  const languageCode = role === 'study' ? entry.studyLang : entry.glossLang;
  // Nothing to translate. Unlike before, the provider is not asked to choose a
  // track "with translation in mind" — the result has to land on a line that
  // exists.
  if (!languageCode) return null;

  // Its own language is not a target: asking YouTube to turn Chinese into Chinese
  // returns the original text, which would be presented as though a translation
  // had happened.
  if (languageCode === wanted) return null;

  const track = entry.trackList.find((t) => t.languageCode === languageCode);
  return track?.isTranslatable ? wanted : null;
}

/** Keep the cache bounded. Map iteration order is insertion order, so the first
 *  key is the oldest — never the video currently on screen. */
function evictOldest() {
  while (videos.size > MAX_CACHED_VIDEOS) {
    const oldest = videos.keys().next().value;
    if (oldest === currentVideoId) break;
    videos.delete(oldest);
  }
}

/** @returns {VideoEntry|null} */
function currentEntry() {
  return currentVideoId ? videos.get(currentVideoId) ?? null : null;
}

/**
 * The cache key for one RENDERING of one source track.
 *
 * A source track and its translation are two different transcripts with the same
 * language code, and they have to coexist: "English" and "English translated into
 * Chinese" is the whole point of the second slot, and it is the one bilingual
 * setup where both lines come from the same source.
 *
 * Keying by language code alone made those collide. The second fetch overwrote
 * the first, so both slots read back the same entry and the panel showed the
 * translation on BOTH lines — the original source text was gone. It also meant
 * choosing the same language twice silently discarded one of the choices.
 *
 * @param {string} languageCode
 * @param {string|null} translateTo
 * @returns {string}
 */
function trackKey(languageCode, translateTo) {
  return `${languageCode}|${translateTo ?? ''}`;
}

/**
 * Store a fetched track, keyed by its source language AND its translation.
 *
 * A translation is recorded alongside its source track rather than filed under
 * the target's code. Keying it by target would mean a video with both a real
 * Japanese track and an English-to-Japanese translation would have the two
 * silently overwrite one another, and the rows would be built from whichever
 * arrived last. It also keeps `hasTrack` honest: a translated line exists
 * because its source track does.
 *
 * @param {VideoEntry} entry
 * @param {object} fetched
 */
function recordTrack(entry, fetched) {
  if (!fetched?.languageCode || !fetched.segments?.length) return false;

  entry.tracks.set(trackKey(fetched.languageCode, fetched.translateTo ?? null), {
    segments: fetched.segments,
    translateTo: fetched.translateTo ?? null,
  });
  entry.error = null;
  return true;
}

/**
 * Hand the content script a transcript it did not fetch.
 *
 * Position reporting is keyed off the segments the content script holds, and on
 * a cache hit nothing is fetched — so a freshly loaded page would report no cue
 * at all until the next cue boundary, which on a paused video never arrives. The
 * panel would then sit at the top of the transcript with nothing highlighted.
 *
 * Not awaited by its callers: it is a notification, and a failure to deliver it
 * is recoverable — the panel still has `activeIndex` in state, and the next
 * report (whenever it comes) corrects everything.
 *
 * The video id travels with it because the content script's own sync() clears
 * the segments whenever it sees a different video. Sending them without saying
 * which video they belong to means the next tick wipes them.
 *
 * @param {VideoEntry} entry
 * @returns {Promise<void>}
 */
async function primeContentPosition(entry) {
  if (trackedTabId === null) return;
  const segments = entry.tracks.get(trackKey(entry.studyLang ?? '', effectiveTranslation(entry, 'study')))?.segments;
  if (!segments?.length) return;

  try {
    await sendToContent(trackedTabId, { type: MSG.SET_TRACK, videoId: entry.videoId, segments });
  } catch {
    // The tab went away, or the page refused. Nothing to do: the panel still has
    // the cue from state, and there is no second place to put it.
  }
}

/**
 * @param {VideoEntry} entry
 * @param {string|null} languageCode
 * @param {string|null} [translateTo]
 * @returns {Promise<object|null>} The fetch result, so the caller can report a failure.
 */
async function loadTrack(entry, languageCode, translateTo = null) {
  if (!languageCode || trackedTabId === null) return null;

  // Already the right rendering — same track AND same translation. A different
  // translation of the same track is NOT a hit, which is the whole point.
  //
  // The check is deliberately about what is cached rather than about deleting
  // the cache and refetching: a translation can fail, and dropping the track
  // first would leave the video with no transcript at all when it does. This
  // way the old text stays on screen and only the error is new.
  const cached = entry.tracks.get(trackKey(languageCode, translateTo ?? null));
  if (cached && cached.translateTo === (translateTo ?? null)) return null;

  let result;
  try {
    result = await sendToContent(trackedTabId, { type: MSG.FETCH_TRACK, languageCode, translateTo });
  } catch (error) {
    entry.error = codeError('TRACK004', error);
    return null;
  }

  if (!recordTrack(entry, result)) {
    return result ?? { languageCode, translateTo: null, segments: [], error: errorText('VIDEO001', languageCode) };
  }
  return result;
}

/**
 * Line up the secondary track against the primary, ready for rendering, and
 * attach the learning marks to each line.
 *
 * The segmentation happens HERE, once per transcript, and the tokens travel
 * with the rows. Segmenting in the panel on every render would redo the same
 * work thousands of times, and the worker is where the dictionary already lives.
 *
 * Tokens are carried over by text where possible. Rows are rebuilt whenever the
 * track changes, which discards them — and without this, switching language
 * silently unmarked the whole transcript until a control was touched by hand.
 *
 * The carry-over is conditional on the settings that produced the tokens still
 * being the settings in force. Carrying them over unconditionally was wrong in a
 * way that stayed hidden: a row's tokens encode a (list, threshold) pair, so
 * reusing tokens after the list changed hands back levels from the wrong list.
 * Worse, `applyMarks` treats "every row already has tokens" as "marking is
 * done" — so a stale carry-over made that check pass while the marks on screen
 * were wrong, and anything waiting for marking to finish saw it as finished
 * immediately.
 *
 * @param {VideoEntry|null} entry
 */
/** @param {VideoEntry|null} entry @returns {object|undefined} */
function activeList(entry) {
  const offered = listsFor(entry);
  return offered.find((list) => list.id === settings.listId) ?? offered[0];
}

/**
 * The id of the list actually in force for an entry.
 *
 * Distinct from `settings.listId`, which is the last list the learner CHOSE. The
 * two differ when the stored choice cannot mark what is on screen — HSK 2.0 is
 * stored, a Japanese video is open, so the effective list is JLPT. Every part of
 * the marking path has to agree on which list is in force, or the dictionary
 * loaded, the cache key and the levels applied come from different lists and the
 * marks silently vanish.
 *
 * @param {VideoEntry|null} entry
 * @returns {string|null}
 */
function effectiveListId(entry) {
  return activeList(entry)?.id ?? null;
}

/**
 * The threshold actually in force for an entry.
 *
 * A threshold is relative to its list — 4 is "upper intermediate" in a 6-level
 * list and something else in a 5-level one — so it cannot be carried across a
 * language switch. When the effective list is the one the learner chose, their
 * stored threshold stands. When it is not (they were on a Chinese list and opened
 * a Japanese video, so JLPT took over), the list's own default is used rather
 * than a number that was never about this list.
 *
 * The stored choice is deliberately NOT overwritten: switching to a Japanese
 * video and back must restore the HSK list and the level that was set for it.
 *
 * @param {VideoEntry|null} entry
 * @returns {number}
 */
function effectiveThreshold(entry) {
  // No entry means no language forcing a different list, so the learner's own
  // number stands. Without this the "active differs from chosen" test below
  // misfires: with no entry, `activeList` falls back to the first list in the
  // index, whose id differs from a stored one, and the stored threshold would be
  // replaced by a default the learner never chose.
  if (!entry) return Number(settings.threshold) || 1;

  const active = activeList(entry);
  if (active && active.id !== settings.listId) return defaultThreshold(active);
  return Number(settings.threshold) || 1;
}

/**
 * The word lists that make sense for what is on screen.
 *
 * A list is only useful for the language its dictionary covers, so offering HSK
 * on a Japanese video (or JLPT on a Chinese one) presents a choice that can only
 * end in "this list does not cover this language". Filtering by language removes
 * the dead option rather than explaining it after the fact.
 *
 * The language is the one the STUDY LINE IS DISPLAYING, not the track's. That is
 * the same value `listCoversLanguage` is judged against, so the two cannot
 * disagree: an English line translated into Chinese is offered the Chinese lists
 * because Chinese is what the learner is reading.
 *
 * `null` when no video is open — the caller then offers everything, because the
 * alternative is an empty dropdown before a video is chosen, and a learner who
 * opens the panel first would see nothing to pick.
 *
 * Note this covers the variants for free. "Japanese", "Japanese (auto-generated)"
 * and "Japanese Machine Translated" are different TRACKS but the same language
 * code, so they resolve to the same set of lists without naming a single one.
 *
 * @param {VideoEntry|null} entry
 * @returns {string|null}
 */
function markableLanguage(entry) {
  if (!entry) return null;
  return shownLanguage(entry, 'study');
}

/**
 * The lists to offer for an entry, or all of them when there is no language to
 * filter by.
 *
 * @param {VideoEntry|null} entry
 * @returns {object[]}
 */
function listsFor(entry) {
  const language = markableLanguage(entry);
  if (!language) return availableLists;

  const covering = availableLists.filter((list) => listCoversLanguage(list, language));
  // A language no list covers — an English video, say — leaves the lists empty.
  // Falling back to all of them keeps the control usable and lets `markedReason`
  // explain why nothing is marked, which is more useful than a disabled control
  // with no way to find out why.
  return covering.length ? covering : availableLists;
}

/**
 * Whether a word list can mark text in this language.
 *
 * BCP-47 is language + optional script + optional region, so "does A cover B" is
 * not a string comparison:
 *
 *   list `zh`      covers `zh`, `zh-Hans`, `zh-Hant` — unspecified means either
 *   list `zh-Hans` covers `zh-Hans`, and `zh` (unknown, so we try)
 *   list `zh-Hans` does NOT cover `zh-Hant` — a stated script must match
 *
 * The asymmetry is deliberate: permissive when the LIST is vague, strict when both
 * sides declare. A stated mismatch is a real one, and marking it would colour text
 * with the wrong vocabulary list.
 *
 * This is the FALLBACK path. The primary fix is that the dictionary now indexes
 * both scripts, so a `zh-Hant` track is genuinely markable and the common case
 * never reaches here. This is for the case the index cannot cover at all — English
 * text against a Chinese list — where attempting it produces silent nothing.
 *
 * @param {object|undefined} list
 * @param {string|null|undefined} languageCode
 * @returns {boolean}
 */
function listCoversLanguage(list, languageCode) {
  if (!list?.language || !languageCode) return false;

  const [langA, ...restA] = String(list.language).split('-');
  const [langB, ...restB] = String(languageCode).split('-');

  // Different languages: no coverage, whatever the scripts say.
  if (langA.toLowerCase() !== langB.toLowerCase()) return false;

  // A script subtag is four letters; a region is two or three digits.
  const scriptA = restA.find((part) => part.length === 4);
  const scriptB = restB.find((part) => part.length === 4);

  // The list is vague about the script, so it covers any script — true here
  // because the index holds both forms.
  if (!scriptA) return true;
  // The list states a script and the text does not: unknown, so try rather than
  // refuse a line that may well be markable.
  if (!scriptB) return true;

  return scriptA.toLowerCase() === scriptB.toLowerCase();
}

/**
 * The language a line is actually DISPLAYING, which is not always its track's: a
 * translated line shows the target's text.
 *
 * @param {VideoEntry} entry
 * @param {'study'|'gloss'} role
 * @returns {string|null}
 */
function shownLanguage(entry, role) {
  return effectiveTranslation(entry, role) ?? (role === 'study' ? entry.studyLang : entry.glossLang);
}

function rebuildRows(entry) {
  if (!entry) return;

  // Which settings the existing tokens were produced for. Anything built under
  // different ones is dropped rather than reused. The EFFECTIVE list, not the
  // stored one: crossing languages changes which list is in force without the
  // learner having chosen anything, and a stored id would leave the old tokens
  // looking reusable.
  const wanted = `${effectiveListId(entry)}:${effectiveThreshold(entry)}`;
  const reusable = entry.markedWith === wanted;

  /** @type {Map<string, object[]>} */
  const previous = new Map();
  if (reusable) {
    // Keep the marks for any line whose text is unchanged. Tokens are a pure
    // function of the text AND the settings, so both have to match.
    for (const row of entry.rows) {
      if (row.tokens) previous.set(row.text, row.tokens);
    }
  } else {
    // Nothing on screen is valid for the current settings, so marking has to run
    // again. Clearing here is what makes that observable.
    entry.markedWith = null;
  }

  const primary = entry.tracks.get(trackKey(entry.studyLang ?? '', effectiveTranslation(entry, 'study')))?.segments ?? [];
  const secondary = entry.glossLang
    ? entry.tracks.get(trackKey(entry.glossLang, effectiveTranslation(entry, 'gloss')))?.segments ?? []
    : [];
  const aligned = secondary.length && primary.length ? alignSecondary(primary, secondary) : null;

  // Whether the STUDY line's text is machine output.
  //
  // This drops the marks, and it is an APPROXIMATION of the real rule, which is
  // language coverage: a line can be marked when a word list exists for the
  // language it is DISPLAYING. Today the only lists are Chinese, so translating
  // the study line away from Chinese does lose its marks, which is what this
  // achieves. It is wrong the other way — an English line translated INTO Chinese
  // is markable and this would refuse — and it should be replaced by the coverage
  // check rather than by another guess. Noted rather than silently left.
  const studyTranslated = Boolean(effectiveTranslation(entry, 'study'));

  entry.rows = primary.map((segment, index) => ({
    start: segment.start,
    duration: segment.duration,
    text: segment.text,
    secondary: aligned ? aligned[index] : '',
    tokens: studyTranslated ? undefined : previous.get(segment.text),
  }));

  // Segmentation is deferred and may not have run yet, so marks are applied
  // separately from the rows being built. A new video therefore renders its text
  // immediately and gains its highlighting a moment later, rather than the panel
  // waiting on a 1.4MB fetch before showing anything.
  applyMarks(entry);
}

/**
 * Load the dictionary if needed, segment the transcript, and mark the rows.
 *
 * @param {VideoEntry|null} entry
 */
async function applyMarks(entry) {
  if (!entry || !entry.rows.length) return;

  // Skip only when every row is genuinely marked for the current settings. The
  // check is on the rows rather than on a remembered flag, because a flag can
  // claim marks that are no longer there — which is precisely how the transcript
  // came back unmarked after a language switch.
  const wanted = `${effectiveListId(entry)}:${effectiveThreshold(entry)}`;
  const allMarked = entry.rows.every((row) => Array.isArray(row.tokens));
  if (entry.markedWith === wanted && allMarked) return;

  // Which dictionary holds this list's words, ensuring it is the loaded one.
  // Not a local variable: `ensureDictionaryFor` sets the module-level dictionary,
  // and the marking below reads it — a shadowing local stayed undefined and threw
  // on `.headwords`.
  const words = await ensureDictionaryFor(effectiveListId(entry)).catch((error) => {
    // A missing word list must not take the transcript down with it: the panel
    // still shows captions, just without marks.
    broadcastError(codeError('DICT001', error));
    return null;
  });
  if (!words) return;

  // The entry may have been rebuilt, or the panel may have moved to another
  // video, while the dictionary was loading. Re-check rather than marking
  // whatever happens to be current.
  if (videos.get(entry.videoId) !== entry) return;

  // Can the chosen list mark the language actually on screen?
  //
  // Asked BEFORE segmenting, because the answer changes what "no marks" means. If
  // the list cannot cover the line at all — English text against a Chinese list —
  // then marking would find nothing and the transcript would render plain with no
  // explanation, which reads as a broken feature. Recording it lets the panel say
  // why. It also skips the segmentation work for a line it cannot help with.
  const list = activeList(entry);
  const covers = listCoversLanguage(list, shownLanguage(entry, 'study'));
  entry.markedReason = covers ? null : `${list?.label ?? 'This list'} does not cover ${shownLanguage(entry, 'study') ?? 'this language'}`;

  if (!covers) {
    entry.rows = entry.rows.map((row) => ({ ...row, tokens: undefined }));
    entry.markedWith = wanted;
    broadcastState();
    return;
  }

  // A cue index is only meaningful against the transcript it was measured on.
  // Re-marking can change the row list, so a remembered index could point at a
  // different line — or past the end.
  if (activeIndex >= entry.rows.length) {
    activeIndex = -1;
    activePaused = false;
  }

  const tokensPerLine = segmentSegments(
    entry.rows.map((row) => ({ start: row.start, text: row.text })),
    dictionary.headwords,
    dictionary.maxWordLength,
  );

  const threshold = effectiveThreshold(entry);

  entry.rows = entry.rows.map((row, index) => ({
    ...row,
    tokens: markLine(tokensPerLine[index], dictionary, list, threshold),
  }));
  entry.markedWith = wanted;

  broadcastState();
}

/**
 * Turn tokens into renderable pieces: text, whether we can define it, and a
 * level when the selected list places it at or beyond the threshold.
 *
 * `defined` is separate from `level` on purpose, and the distinction is the
 * whole point of keeping the dictionary independent of the graded lists. A word
 * can be perfectly ordinary, absent from the list being used, and still be a
 * word the learner wants defined — 这样 has no HSK 2.0 level but is HSK 3.0
 * level 2, so on HSK 2.0 it is "definition yes, colour no", not invisible.
 *
 * Conflating the two is what made whole sentences look unmarked.
 *
 * @param {Array<{text: string, known: boolean}>} tokens
 * @param {object} dictionary
 * @param {object|undefined} list
 * @param {number} threshold
 * @returns {Array<{text: string, defined: boolean, level: number|null}>}
 */
function markLine(tokens, dictionary, list, threshold) {
  return tokens.map((token) => {
    // Only words we hold a definition for are worth making interactive. An
    // unknown token has nothing to show, so it stays plain text.
    const defined = token.known && Boolean(lookup(dictionary, token.text));
    if (!defined || !list) return { text: token.text, defined, level: null };

    const level = levelOf(dictionary, list.id, token.text);
    if (level === null || level < threshold) return { text: token.text, defined, level: null };
    return { text: token.text, defined, level };
  });
}

// --- Panel intents ----------------------------------------------------------

/**
 * The learner chose a subtitle track. Remember it, then apply it.
 *
 * Separate from `selectTrack` because choosing and rendering are different
 * operations: a choice is a preference that should outlive the video, while
 * re-rendering an existing choice must not overwrite the preference with
 * whatever happens to be on screen.
 *
 * @param {'study'|'gloss'} which
 * @param {string|null} languageCode
 */
async function chooseTrack(which, languageCode) {
  if (which === 'study') settings.studyLanguage = languageCode || null;
  else settings.glossLanguage = languageCode || null;
  persistSettings();
  await selectTrack(which, languageCode);
}

/**
 * Put a track on screen for the current video.
 *
 * Deliberately does NOT touch settings. It used to, and that was wrong in a way
 * that stayed hidden until translation needed to re-render without changing the
 * choice: the stored preference is null on any video where the learner has not
 * picked a language, because the refresh path adopts the provider's default
 * without writing it back. Re-applying the preference on a re-render therefore
 * cleared the track that was already loaded, and the transcript went blank.
 *
 * @param {'study'|'gloss'} which
 * @param {string|null} languageCode
 */
async function selectTrack(which, languageCode) {
  const entry = currentEntry();
  if (!entry) {
    broadcastState();
    return;
  }

  // An empty string from the panel means "none" for the gloss; for the study
  // line it means "fall back to whatever the video offers".
  if (which === 'study') entry.studyLang = languageCode || null;
  else entry.glossLang = languageCode || null;

  await loadTrack(entry, languageCode, effectiveTranslation(entry, which));
  rebuildRows(entry);
  broadcastState();
}

/** @param {number} seconds */
async function forwardSeek(seconds) {
  if (trackedTabId === null) return;
  try {
    await sendToContent(trackedTabId, { type: MSG.CONTENT_SEEK, seconds });
  } catch (error) {
    broadcastError(codeError('CONN003', error));
  }
}

// --- State sent to the panel ------------------------------------------------

/** @returns {object} */
function deriveState() {
  const entry = currentEntry();

  if (!entry) {
    return {
      videoId: null,
      title: '',
      isLive: false,
      trackList: [],
      translationLanguages: [],
      translationAvailable: {},
      studyTranslation: null,
      glossTranslation: null,
      translateInto: settings.translateInto,
      studyTranslated: Boolean(settings.studyTranslated),
      glossTranslated: Boolean(settings.glossTranslated),
      study: null,
      gloss: null,
      rows: [],
      activeIndex,
      activePaused,
      error: pendingError ?? (trackedTabId === null ? `No ${providerNames()} tab is active.` : null),
      // No entry, so no language to filter by: every list is offered rather than
      // none, because an empty dropdown before a video is chosen would leave
      // nothing to pick and no way to find out why.
      learning: learningState(null),
      lists: availableLists,
    };
  }

  return {
    videoId: currentVideoId,
    title: entry.title,
    isLive: Boolean(entry.isLive),
    trackList: entry.trackList,
    // Which languages this video can be auto-translated into. Supplied per
    // video rather than built into the panel, so the options can never drift
    // from what YouTube will actually serve for what is on screen.
    translationLanguages: entry.translationLanguages ?? [],
    // Whether each track can be translated at all, so the panel can disable the
    // menu for a track that cannot. YouTube reports `isTranslatable` per track
    // and applying a translation to a track that lacks it returns the original
    // text — a menu that appears to work and changes nothing.
    translationAvailable: Object.fromEntries(
      (entry.trackList ?? []).map((track) => [track.languageCode, Boolean(track.isTranslatable)]),
    ),
    // What is actually on screen for each line, which is not always what was
    // asked for: a video whose tracks cannot be translated falls back to the
    // original text. Both are present because EITHER line can be translated, so a
    // null here means "this line is not translated", never "this line cannot be".
    studyTranslation: effectiveTranslation(entry, 'study'),
    glossTranslation: effectiveTranslation(entry, 'gloss'),
    translateInto: settings.translateInto,
    studyTranslated: Boolean(settings.studyTranslated),
    glossTranslated: Boolean(settings.glossTranslated),
    // Why nothing is marked, when the chosen list cannot cover the line. Sent so
    // the panel can explain a plain transcript rather than leaving it looking
    // broken — "HSK 3.0 does not cover en" is actionable; an unmarked transcript
    // is not.
    markedReason: entry.markedReason ?? null,
    study: entry.studyLang,
    gloss: entry.glossLang,
    rows: entry.rows,
    // Carried in state rather than only as an event, so a panel that opens
    // mid-video starts where playback is instead of at the top.
    activeIndex,
    // True when that line is the one that just finished rather than the one being
    // spoken. The panel dims in that case rather than dropping the highlight.
    activePaused,
    // A translation failure is reported BEFORE the track error. They are
    // separate on purpose: a track error replaces the transcript and blocks the
    // cache, while a translation error means "the text below is the original,
    // not the language you asked for" — which the learner needs to know even
    // though there is a perfectly good transcript on screen.
    error: pendingError ?? translationError ?? entry.error,
    // The entry decides which lists are offered, so the options and the marks
    // agree about what is selectable for this video's language.
    learning: learningState(entry),
    lists: availableLists,
  };
}

/**
 * Everything the panel needs to render its controls, in one object.
 *
 * The panel renders controls from the settings schema, so what it needs is the
 * current value *and* the options available right now — and both the list options
 * and the threshold options depend on what is on screen, which only the worker
 * knows about.
 *
 * @param {VideoEntry|null} [entry] The entry whose language decides the options.
 * @returns {object}
 */
function learningState(entry = null) {
  const offered = listsFor(entry);
  const active = offered.find((list) => list.id === settings.listId) ?? offered[0];
  return {
    view: settings.view,
    // Sent so the panel can put its chrome back the way it was. Its absence was a
    // real bug: every state push re-applied `undefined`, which meant the panel
    // started full every time and the control appeared to do nothing — the setting
    // was stored, broadcast, and then immediately overwritten.
    layout: settings.layout,
    fontSize: settings.fontSize,
    // The list actually in force, not the raw stored id. A stored value can name
    // a list that no longer exists (data changed under it), one that never did, or
    // one that does not cover this video's language — and reporting the raw id
    // tells the panel to select an option that is not in its dropdown. The control
    // then renders blank while the marking uses the fallback list, so the panel
    // and the marks disagree about what is selected.
    listId: active?.id ?? null,
    threshold: effectiveThreshold(entry),
    studyLanguage: settings.studyLanguage,
    glossLanguage: settings.glossLanguage,
    translateInto: settings.translateInto,
    studyTranslated: settings.studyTranslated,
    glossTranslated: settings.glossTranslated,
    // Only the lists that can mark what is on screen. Supplied here rather than in
    // the schema, because which lists exist is a property of the data and which are
    // useful is a property of the video.
    listOptions: offered.map((list) => ({ value: list.id, label: list.label })),
    thresholdOptions: active
      ? Array.from({ length: active.levelCount }, (_, i) => ({ value: i + 1, label: `${i + 1}+` }))
      : [],
  };
}

// --- Settings ---------------------------------------------------------------
// One object, one storage key, one place to read and one to write. Adding a
// setting is a change to src/common/settings.js and nothing here.

async function restoreSettings() {
  try {
    const stored = await chrome.storage.local.get(storageKey);
    settings = normalise(stored?.[storageKey]);
  } catch {
    // Storage unavailable, or the worker is mid-shutdown. Defaults are a fine
    // answer and not worth failing startup over.
    settings = defaults();
  }
}

function persistSettings() {
  chrome.storage.local.set(toStorage(settings)).catch(() => {});
}

/**
 * Apply one setting, doing whatever else that change implies.
 *
 * Most settings are just stored. The ones that need follow-up declare it here,
 * so the panel never has to know which changes are the expensive ones — it
 * sends a value and the worker decides what that costs.
 *
 * @param {string} id
 * @param {any} value
 */
async function applySetting(id, value) {
  const declared = definition(id);
  if (!declared) return; // unknown id; nothing to do and nothing to report

  settings[id] = declared.coerce ? declared.coerce(value) : value;

  switch (id) {
    case 'listId':
      // A threshold is relative to its list, so moving list takes that list's
      // own starting point rather than carrying a number that has changed
      // meaning.
      settings.threshold = defaultThreshold(listById(settings.listId));
      rebuildRows(currentEntry());
      break;

    case 'threshold':
      rebuildRows(currentEntry());
      break;

    case 'studyLanguage':
      // The learner picked a different language, so the fetched track is no
      // longer what is wanted. Re-choosing is what re-fetches it.
      void chooseTrack('study', settings.studyLanguage);
      break;
    case 'glossLanguage':
      void chooseTrack('gloss', settings.glossLanguage);
      // Changing the gloss track changes what there is to translate, so the
      // error from the previous track is no longer about anything on screen.
      translationError = null;
      break;

    case 'translateInto':
    case 'studyTranslated':
    case 'glossTranslated': {
      // Only the RENDERING changes, not the chosen language, so this re-renders
      // rather than re-choosing. All three settings decide the same thing — what
      // the lines show — so they share a branch.
      //
      // No cache surgery: loadTrack compares the cached rendering against the
      // one wanted, so a different target refetches and an unreachable target
      // leaves the existing text alone.
      const entry = currentEntry();

      // A line whose track cannot be translated has nothing to fetch and is
      // already showing the original, so say WHY rather than silently doing
      // nothing: the learner ticked the box and is looking at unchanged text, and
      // without this the feature appears broken.
      const wanted = Boolean(settings.translateInto && (settings.studyTranslated || settings.glossTranslated));
      const refused =
        (settings.studyTranslated && entry?.studyLang && !effectiveTranslation(entry, 'study')) ||
        (settings.glossTranslated && entry?.glossLang && !effectiveTranslation(entry, 'gloss'));
      translationError = wanted && refused ? errorText('TRACK001') : null;

      // Re-render BOTH lines. Either may have changed rendering, and a line whose
      // rendering is already cached returns immediately — so this is cheap when
      // only one of them moved. Doing only the study line was a real bug: the
      // gloss kept its old text, so ticking a box changed nothing on screen.
      const study = entry?.studyLang ?? null;
      const gloss = entry?.glossLang ?? null;
      if (!study && !gloss) {
        broadcastState();
        break;
      }
      void (async () => {
        if (study) await selectTrack('study', study);
        if (gloss) await selectTrack('gloss', gloss);
      })();
      break;
    }

    default:
      // view and fontSize are pure presentation: the panel applies them and
      // nothing here needs to react.
      break;
  }

  persistSettings();
  broadcastState();
}

// Called at the bottom of this file rather than here, so the whole worker is
// defined before anything asynchronous can run. A module-scope rejection would
// abort evaluation, and a worker that fails to evaluate never answers the panel
// — which looks, from the panel's side, exactly like nothing happening.

// --- Action -----------------------------------------------------------------

/** Open the side panel when the toolbar icon is clicked. */
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// --- Parked: tab capture ------------------------------------------------------
// Unchanged from the capture phase. Reachable by flipping USE_AUDIO_CAPTURE in
// src/sidepanel/sidepanel.js; the offscreen document is created on demand.

/**
 * @param {{streamId: string, tabId: number, tabTitle?: string}} request
 * @returns {Promise<void>}
 */
async function startCapture({ streamId, tabId, tabTitle }) {
  await stopCapture(); // one capture at a time
  await ensureOffscreenDocument();

  session = { tabId, streamId, tabTitle: tabTitle ?? '' };

  await chrome.runtime.sendMessage({
    type: MSG.START_CAPTURE,
    target: TARGET.OFFSCREEN,
    streamId,
    tabTitle: session.tabTitle,
  });
}

/** @returns {Promise<void>} */
async function stopCapture() {
  if (!session) return;
  session = null;
  // The offscreen document owns the stream; it tears itself down after stopping.
  await chrome.runtime.sendMessage({ type: MSG.STOP_CAPTURE, target: TARGET.OFFSCREEN }).catch(() => {
    // Offscreen document may already be gone — that is a valid stopped state.
  });
}

/** @returns {Promise<void>} */
async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (existing.length > 0) return;

  // `offscreen.createDocument` rejects if another call raced us here; swallow it.
  await chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Hold the captured tab audio stream and run the transcription engine.',
    })
    .catch((error) => {
      if (!String(error?.message ?? error).includes('Only a single offscreen')) throw error;
    });
}

// --- Startup -----------------------------------------------------------------
// Everything above is defined by now. restoreSettings swallows its own
// failures, so this cannot reject and abort the worker.
//
// The dictionary is primed straight away rather than on first use: it decides
// which lists the panel can offer, and a learner opening the panel should not
// have to wait for a 1.4MB fetch to see the controls.
//
// `settingsReady` is the same promise the refresh path awaits, so a panel that
// connects during this read cannot seed a video's languages from the defaults
// before the stored ones have landed.
settingsReady = restoreSettings();
void settingsReady.then(primeDictionary);

/**
 * Load the list index once at startup so the panel knows what it can offer, then
 * load the dictionary for the active list's language.
 *
 * Two loads rather than one, deliberately. The index is ~1 KB and names every
 * list; a dictionary is ~1.4-3 MB of words. Loading only the index eagerly means
 * the language and list pickers work immediately and a second language costs
 * nothing until one of its lists is actually selected — with one language this
 * was all inside one file, and with two that would mean parsing every language's
 * words on every worker wake just to fill a dropdown.
 *
 * @returns {Promise<void>}
 */
async function primeDictionary() {
  try {
    listIndex = await loadIndex(indexUrl());
    availableLists = listIndex.lists;

    // Fall back to the list that can actually mark the most words, rather than
    // to whichever happens to be first in the data.
    //
    // This was a real bug: the first list was HSK 2.0, which places 4,993 of
    // 11,470 words. The remaining 6,477 exist only in HSK 3.0, so a learner
    // opening the panel with no stored preference saw 早安 unmarked and
    // reasonably concluded the highlighting was broken. Defaulting to the
    // widest list shows marks immediately; a narrower list remains a choice.
    //
    // "Widest" means widest in the PRIMARY language — the first the index
    // declares — not widest overall. With one language those were the same
    // thing; with two they are not. JLPT places 11,158 words and HSK 3.0 places
    // 10,969, so widest-overall silently made Japanese the default for every new
    // user — and on a Chinese video that list covers nothing, which is the exact
    // unmarked-transcript symptom the widest-list rule was added to remove.
    const primaryLanguage = availableLists[0]?.language;
    const primary = availableLists.filter((list) => list.language === primaryLanguage);
    const widest = [...primary].sort((a, b) => (b.levelled ?? 0) - (a.levelled ?? 0))[0];

    if (!settings.listId || !availableLists.some((list) => list.id === settings.listId)) {
      settings.listId = widest?.id ?? null;
      // The learner's own level, as the chosen list declares it.
      settings.threshold = defaultThreshold(widest);
    }

    // Broadcast NOW, before loading any words. The picks can be populated and the
    // panel is told what exists; making that wait on a 1.4-3 MB parse would leave
    // the dropdown empty for however long that takes. The words follow below and
    // broadcast again when the rows can actually be marked.
    broadcastState();
    rebuildRows(currentEntry());

    await ensureDictionaryFor(settings.listId);
  } catch (error) {
    broadcastError(codeError('DICT001', error));
  }
  broadcastState();

  // Mark whatever is already on screen. The transcript usually arrives before
  // the word list does, so without this the rows would sit unmarked until
  // something else happened to rebuild them.
  rebuildRows(currentEntry());
}
