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
import { alignSecondary } from '../common/transcript.js';
import { loadDictionary, levelOf, lookup } from '../learn/wordlist.js';
import { segmentSegments } from '../learn/segment.js';

/** How many videos to keep transcripts for before evicting the oldest. */
const MAX_CACHED_VIDEOS = 6;
const YOUTUBE_URL = /^https:\/\/[^/]*youtube\.com\//;
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/**
 * @typedef {Object} VideoEntry
 * @property {string} videoId
 * @property {string} title
 * @property {boolean} isLive
 * @property {object[]} trackList            Available tracks, as offered to the panel.
 * @property {boolean} stale                 The page could not report its tracks.
 * @property {string|null} primaryLang
 * @property {string|null} secondaryLang
 * @property {Map<string, object[]>} tracks  languageCode -> segments.
 * @property {object[]} rows                 Primary segments, with tokens where marked.
 * @property {string|null} error
 * @property {string|null} [markedWith]      `listId:threshold` the rows were marked for.
 */

/** @type {Map<string, VideoEntry>} videoId -> entry. Insertion order doubles as eviction order. */
const videos = new Map();

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
    case MSG.SET_PRIMARY:
      void selectTrack('primary', message.languageCode);
      return;
    case MSG.SET_SECONDARY:
      void selectTrack('secondary', message.languageCode);
      return;
    case MSG.SEEK:
      void forwardSeek(message.seconds);
      return;

    // --- Learning layer ------------------------------------------------------
    case MSG.SET_LIST:
      learning.listId = message.listId;
      // Take the new list's own default rather than carrying a threshold from a
      // list with a different number of levels, where it would mean something
      // else entirely.
      learning.threshold = defaultThreshold(message.listId);
      persistLearning();
      // Rows are rebuilt because switching lists can change which levels exist,
      // so the existing marks are no longer valid.
      rebuildRows(currentEntry());
      broadcastState();
      return;

    case MSG.SET_THRESHOLD:
      learning.threshold = Number(message.threshold);
      persistLearning();
      rebuildRows(currentEntry());
      broadcastState();
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
 * How the learner's own preferences are held.
 *
 * `threshold` is the lowest level worth marking. It is configurable rather than
 * derived, because the honest answer to "is my own level marked?" is both: a
 * pure difficulty signal starts above you, a study aid starts at you.
 *
 * @type {{listId: string|null, threshold: number}}
 */
const learning = { listId: null, threshold: 0 };

/**
 * The level a list should mark from, if the learner has not chosen one.
 *
 * HSK 4 is where the user is studying, so marking starts there. Clamped by the
 * caller to the list's own range, because a threshold only means something
 * relative to the list it applies to.
 */
function defaultThreshold(listId) {
  return listId?.startsWith('hsk') ? 4 : 1;
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

/** @type {string|null} */
let pendingError = null;

/** @type {string|null} Persisted across restarts; transcripts are not. */
let secondaryPreference = null;

/**
 * The word lists offered to the panel. Empty until the dictionary loads, which
 * is why the panel has to tolerate an empty list rather than assume one.
 *
 * @type {object[]}
 */
let availableLists = [];

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
      activeIndex = message.index;
      panelPort?.postMessage({ type: MSG.POSITION, index: message.index, seconds: message.seconds });
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
    const dictionary = await loadDictionary();
    panelPort.postMessage({
      type: MSG.ENTRY,
      word,
      entry: lookup(dictionary, word),
      levels: levelsFor(dictionary, word),
      listId: learning.listId,
    });
  } catch (error) {
    broadcastError(`Could not load the dictionary: ${error?.message ?? error}`);
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
 * Keep up with the user. Non-YouTube tabs are ignored rather than clearing the
 * panel, so glancing at another tab and coming back does not lose your place.
 *
 * @param {number} tabId
 */
async function onTabActivated(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !YOUTUBE_URL.test(tab.url ?? '')) return;
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
 * Find the frame holding the video and make sure both our scripts are running in
 * it.
 *
 * The video is not always in the tab's top frame, so injecting blindly is not
 * safe. `webNavigation.getAllFrames` tells us which frame is a youtube.com
 * document.
 *
 * Both files are injected, not just the content script: on a tab that was
 * already open when the extension loaded, the manifest-declared content scripts
 * are absent too, so the MAIN-world bridge would be missing and every request
 * would come back empty.
 *
 * @param {number} tabId
 * @returns {Promise<number|null>} frameId, or null if there is no such frame.
 */
async function ensureContentScript(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (!frames?.length) return null;

  const frame =
    frames.find((f) => f.frameId === 0 && YOUTUBE_URL.test(f.url ?? '')) ??
    frames.find((f) => YOUTUBE_URL.test(f.url ?? ''));
  if (!frame) return null;

  if (injectedFrames.has(frameKey(tabId, frame.frameId))) return frame.frameId;

  const target = { tabId, frameIds: [frame.frameId] };
  try {
    // Bridge first: it is what the content script talks to.
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['src/content/page-bridge.js'] });
    await chrome.scripting.executeScript({ target, files: ['src/content/youtube-content.js'] });
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
  if (frameId === null) throw new Error('no youtube frame');

  let timer = 0;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, { ...message, target: TARGET.CONTENT }, { frameId }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the content script did not answer ${message.type} within ${CONTENT_TIMEOUT_MS}ms`)),
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
  try {
    await refreshInner();
  } catch (error) {
    pendingError = `Could not read the video: ${error?.message ?? error}`;
    broadcastState();
  }
}

/** @returns {Promise<void>} */
async function refreshInner() {
  if (trackedTabId !== null) {
    // A tracked tab can be closed or navigated away since we last looked.
    const alive = await chrome.tabs.get(trackedTabId).catch(() => null);
    if (!alive || !YOUTUBE_URL.test(alive.url ?? '')) trackedTabId = null;
  }

  if (trackedTabId === null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !YOUTUBE_URL.test(tab.url ?? '')) {
      pendingError = 'No YouTube video in the active tab.';
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
    pendingError = `Could not reach the page (${error?.message ?? error}).`;
    broadcastState();
    return;
  }

  if (!described?.video) {
    pendingError = described?.error ?? 'Could not read this video.';
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
  }

  // Nothing to fetch and nothing to show: say so rather than leaving the panel
  // on an empty transcript with no explanation.
  //
  // An empty list only means that when the page could actually report its
  // tracks. If the page was stale it simply could not tell us, and the captions
  // are still worth asking the player API for.
  if (!entry.trackList.length && !entry.stale) {
    entry.error = 'This video has no captions.';
    entry.rows = [];
    broadcastState();
    return;
  }

  // Already in hand: this is what makes swapping between YouTube tabs instant,
  // and what keeps a video's transcript alive while you look at others.
  if (isCached(entry)) {
    rebuildRows(entry);
    broadcastState();
    return;
  }

  // A cache miss, so pay for a download. The track to load is the one already
  // chosen for this video, or the content script's default when it is new.
  let provided;
  try {
    provided = await sendToContent(trackedTabId, { type: MSG.PROVIDE, languageCode: entry.primaryLang });
  } catch (error) {
    pendingError = `Could not fetch captions (${error?.message ?? error}).`;
    broadcastState();
    return;
  }

  if (!provided?.ok && !provided?.fetched) {
    entry.error = provided?.error ?? 'Could not load captions.';
    broadcastState();
    return;
  }

  if (provided.fetched?.segments?.length) {
    entry.tracks.set(provided.fetched.languageCode, provided.fetched.segments);
    entry.primaryLang = provided.fetched.languageCode;
    entry.error = null;
  } else if (provided.fetched?.error) {
    entry.error = provided.fetched.error;
  }

  rebuildRows(entry);

  // Show the primary immediately, then fill in the second language.
  const wantsSecondary = entry.secondaryLang && !entry.tracks.has(entry.secondaryLang);
  if (wantsSecondary) broadcastState();

  if (wantsSecondary) {
    await loadTrack(entry, entry.secondaryLang);
    rebuildRows(entry);
  }

  broadcastState();
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
  if (currentVideoId !== video.videoId) activeIndex = -1;

  currentVideoId = video.videoId;

  let entry = videos.get(video.videoId);
  if (!entry) {
    entry = {
      videoId: video.videoId,
      title: video.title,
      isLive: video.isLive,
      trackList: video.trackList ?? [],
      stale: Boolean(video.stale),
      primaryLang: null,
      secondaryLang: secondaryPreference,
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
    entry.stale = Boolean(video.stale);
  }

  // Drop any selection whose track no longer exists on this video.
  if (entry.primaryLang && !hasTrack(entry, entry.primaryLang)) entry.primaryLang = null;
  if (entry.secondaryLang && !hasTrack(entry, entry.secondaryLang)) entry.secondaryLang = null;

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
  return Boolean(entry.primaryLang && entry.tracks.has(entry.primaryLang) && entry.rows.length);
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
 * @param {VideoEntry} entry
 * @param {string|null} languageCode
 * @returns {Promise<void>}
 */
async function loadTrack(entry, languageCode) {
  if (!languageCode || entry.tracks.has(languageCode) || trackedTabId === null) return;

  let result;
  try {
    result = await sendToContent(trackedTabId, { type: MSG.FETCH_TRACK, languageCode });
  } catch (error) {
    entry.error = `Could not load ${languageCode}: ${error?.message ?? error}`;
    return;
  }

  if (result?.segments?.length) {
    entry.tracks.set(result.languageCode, result.segments);
    entry.error = null;
  } else {
    entry.error = result?.error ?? `No captions for ${languageCode}.`;
  }
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
 * @param {VideoEntry|null} entry
 */
function rebuildRows(entry) {
  if (!entry) return;

  // Keep the marks for any line whose text is unchanged. Tokens are a pure
  // function of the text, so if the text is the same the tokens still hold.
  /** @type {Map<string, object[]>} */
  const previous = new Map();
  for (const row of entry.rows) {
    if (row.tokens) previous.set(row.text, row.tokens);
  }

  const primary = entry.tracks.get(entry.primaryLang ?? '') ?? [];
  const secondary = entry.secondaryLang ? entry.tracks.get(entry.secondaryLang) ?? [] : [];
  const aligned = secondary.length && primary.length ? alignSecondary(primary, secondary) : null;

  entry.rows = primary.map((segment, index) => ({
    start: segment.start,
    duration: segment.duration,
    text: segment.text,
    secondary: aligned ? aligned[index] : '',
    tokens: previous.get(segment.text),
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
  const wanted = `${learning.listId}:${learning.threshold}`;
  const allMarked = entry.rows.every((row) => Array.isArray(row.tokens));
  if (entry.markedWith === wanted && allMarked) return;

  let dictionary;
  try {
    dictionary = await loadDictionary();
  } catch (error) {
    // A missing word list must not take the transcript down with it: the panel
    // still shows captions, just without marks.
    broadcastError(`Word list unavailable: ${error?.message ?? error}`);
    return;
  }

  // The entry may have been rebuilt, or the panel may have moved to another
  // video, while the dictionary was loading. Re-check rather than marking
  // whatever happens to be current.
  if (videos.get(entry.videoId) !== entry) return;

  // A cue index is only meaningful against the transcript it was measured on.
  // Re-marking can change the row list, so a remembered index could point at a
  // different line — or past the end.
  if (activeIndex >= entry.rows.length) activeIndex = -1;

  const tokensPerLine = segmentSegments(
    entry.rows.map((row) => ({ start: row.start, text: row.text })),
    dictionary.words,
    dictionary.maxWordLength,
  );

  const list = dictionary.lists.find((l) => l.id === learning.listId) ?? dictionary.lists[0];
  const threshold = learning.threshold;

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
 * @param {'primary'|'secondary'} which
 * @param {string|null} languageCode
 */
async function selectTrack(which, languageCode) {
  const entry = currentEntry();
  if (!entry) return;

  if (which === 'primary') {
    entry.primaryLang = languageCode ?? entry.primaryLang;
  } else {
    // '' from the panel means "none".
    entry.secondaryLang = languageCode || null;
    secondaryPreference = entry.secondaryLang;
    persistPreference();
  }

  await loadTrack(entry, which === 'primary' ? entry.primaryLang : entry.secondaryLang);
  rebuildRows(entry);
  broadcastState();
}

/** @param {number} seconds */
async function forwardSeek(seconds) {
  if (trackedTabId === null) return;
  try {
    await sendToContent(trackedTabId, { type: MSG.CONTENT_SEEK, seconds });
  } catch (error) {
    broadcastError(String(error?.message ?? error));
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
      primary: null,
      secondary: null,
      rows: [],
      activeIndex,
      error: pendingError ?? (trackedTabId === null ? 'No YouTube tab is active.' : null),
      learning: { ...learning },
      lists: availableLists,
    };
  }

  return {
    videoId: currentVideoId,
    title: entry.title,
    isLive: Boolean(entry.isLive),
    trackList: entry.trackList,
    primary: entry.primaryLang,
    secondary: entry.secondaryLang,
    rows: entry.rows,
    // Carried in state rather than only as an event, so a panel that opens
    // mid-video starts where playback is instead of at the top.
    activeIndex,
    error: pendingError ?? entry.error,
    learning: { ...learning },
    lists: availableLists,
  };
}

// --- Preferences ------------------------------------------------------------
// Only the language choice is persisted. Transcripts stay in memory: they are
// large, cheap to refetch, and the worker is kept alive by an open panel.

async function restorePreference() {
  try {
    const stored = await chrome.storage.local.get(['secondaryLanguage', 'learning']);
    secondaryPreference = stored?.secondaryLanguage ?? null;
    if (stored?.learning) {
      learning.listId = stored.learning.listId ?? null;
      learning.threshold = Number(stored.learning.threshold) || 0;
    }
  } catch {
    // Storage is unavailable (or the worker is mid-shutdown). Missing
    // preferences are not worth failing startup over.
    secondaryPreference = null;
  }
}

function persistPreference() {
  chrome.storage.local.set({ secondaryLanguage: secondaryPreference }).catch(() => {});
}

function persistLearning() {
  chrome.storage.local.set({ learning: { ...learning } }).catch(() => {});
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
// Everything above is defined by now. restorePreference swallows its own
// failures, so this cannot reject and abort the worker.
//
// The dictionary is primed straight away rather than on first use: it decides
// which lists the panel can offer, and a learner opening the panel should not
// have to wait for a 1.4MB fetch to see the controls.
void restorePreference().then(primeDictionary);

/**
 * Load the dictionary once at startup so the panel knows what it can offer, and
 * settle on a default list if the learner has not chosen one.
 *
 * @returns {Promise<void>}
 */
async function primeDictionary() {
  try {
    const dictionary = await loadDictionary();
    availableLists = dictionary.lists;

    // Fall back to the list that can actually mark the most words, rather than
    // to whichever happens to be first in the data.
    //
    // This was a real bug: the first list was HSK 2.0, which places 4,993 of
    // 11,470 words. The remaining 6,477 exist only in HSK 3.0, so a learner
    // opening the panel with no stored preference saw 早安 unmarked and
    // reasonably concluded the highlighting was broken. Defaulting to the
    // widest list shows marks immediately; a narrower list remains a choice.
    if (!learning.listId || !dictionary.lists.some((list) => list.id === learning.listId)) {
      const widest = [...dictionary.lists].sort((a, b) => (b.levelled ?? 0) - (a.levelled ?? 0))[0];
      learning.listId = widest?.id ?? null;

      // The learner's own level, clamped to what the list actually has.
      learning.threshold = Math.min(defaultThreshold(learning.listId), widest?.levelCount ?? 1);
    }
  } catch (error) {
    broadcastError(`Word list unavailable: ${error?.message ?? error}`);
  }
  broadcastState();

  // Mark whatever is already on screen. The transcript usually arrives before
  // the word list does, so without this the rows would sit unmarked until
  // something else happened to rebuild them.
  rebuildRows(currentEntry());
}
