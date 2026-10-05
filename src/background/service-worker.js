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

/** How many videos to keep transcripts for before evicting the oldest. */
const MAX_CACHED_VIDEOS = 6;
const YOUTUBE_URL = /^https:\/\/[^/]*youtube\.com\//;
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/**
 * @typedef {Object} VideoEntry
 * @property {string} title
 * @property {boolean} isLive
 * @property {object[]} trackList            Available tracks, as offered to the panel.
 * @property {string|null} primaryLang
 * @property {string|null} secondaryLang
 * @property {Map<string, object[]>} tracks  languageCode -> segments.
 * @property {object[]} rows                 Primary segments with secondary text aligned.
 * @property {string|null} error
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
    default:
      // Anything else from the panel is ignored rather than thrown on.
      return;
  }
}

/** @type {string|null} */
let pendingError = null;

/** @type {string|null} Persisted across restarts; transcripts are not. */
let secondaryPreference = null;

/** @type {{tabId: number, streamId: string, tabTitle: string}|null} */
let session = null;

// --- Message routing --------------------------------------------------------

// Both the panel and content scripts address the worker, but on different
// channels: the panel uses its port (see handlePanelMessage above), content
// scripts use chrome.runtime.sendMessage and land here. Panel intents that
// arrive here anyway — the parked capture control below — are handled too, so
// the capture path keeps working whether or not a port is connected.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== TARGET.BACKGROUND) return false;

  switch (message.type) {
    // --- From content scripts ------------------------------------------------
    case MSG.CONTENT_POSITION:
      // The content script's index is against the segments it was given for its
      // current video, which is the same list we rendered.
      if (panelPort) panelPort.postMessage({ type: MSG.POSITION, index: message.index, seconds: message.seconds });
      return false;

    case MSG.CONTENT_VIDEO_CHANGED:
      void onNavigation();
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
 * The page fired a navigation event. Probe first: YouTube fires these for
 * things that do not change the video, and fetching a whole track each time
 * would be wasteful.
 */
async function onNavigation() {
  if (trackedTabId === null) return;

  let probe;
  try {
    probe = await sendToContent(trackedTabId, { type: MSG.PROBE });
  } catch {
    return; // Tab is mid-navigation; the next event will pick it up.
  }

  if (probe?.video?.videoId && probe.video.videoId !== currentVideoId) {
    await refresh();
    broadcastState();
  }
}

// --- Resolving the current video --------------------------------------------

/**
 * Find the frame holding the video and make sure both our scripts are running
 * in it.
 *
 * The video is not always in the tab's top frame, so injecting blindly is not
 * safe. `webNavigation.getAllFrames` tells us which frame is a youtube.com
 * document.
 *
 * Both files are injected, not just the content script: on a tab that was
 * already open when the extension loaded, the manifest-declared content scripts
 * are absent too, so the MAIN-world bridge would be missing and every request
 * would come back empty. Both files carry re-entry guards, which is what makes
 * injecting unconditionally safe.
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

  const target = { tabId, frameIds: [frame.frameId] };
  try {
    // Bridge first: it is what the content script talks to.
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['src/content/page-bridge.js'] });
    await chrome.scripting.executeScript({ target, files: ['src/content/youtube-content.js'] });
  } catch {
    // Already injected, or the page refuses. Either way, try to talk to it.
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

  let provided;
  try {
    provided = await sendToContent(trackedTabId, { type: MSG.PROVIDE });
  } catch (error) {
    pendingError = `Could not reach the page (${error?.message ?? error}).`;
    broadcastState();
    return;
  }

  if (!provided?.ok) {
    pendingError = provided?.error ?? 'Could not read this video.';
    // Still record the video so its title shows even without captions.
    if (provided?.video) adoptVideo(provided.video);
    broadcastState();
    return;
  }

  pendingError = null;
  const entry = adoptVideo(provided.video);

  // The PROVIDE call already fetched the default track; record it.
  if (provided.fetched?.segments?.length) {
    entry.tracks.set(provided.fetched.languageCode, provided.fetched.segments);
    if (!entry.primaryLang) entry.primaryLang = provided.fetched.languageCode;
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
  currentVideoId = video.videoId;

  let entry = videos.get(video.videoId);
  if (!entry) {
    entry = {
      title: video.title,
      isLive: video.isLive,
      trackList: video.trackList ?? [],
      primaryLang: null,
      secondaryLang: secondaryPreference,
      tracks: new Map(),
      rows: [],
      error: null,
    };
    videos.set(video.videoId, entry);
    evictOldest();
  } else {
    // Refresh metadata, keep any already-fetched transcripts.
    entry.title = video.title ?? entry.title;
    entry.isLive = video.isLive;
    entry.trackList = video.trackList ?? entry.trackList;
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

/** Line up the secondary track against the primary, ready for rendering.
 *  Carries `duration` so the panel's SRT export has real cue ends. */
function rebuildRows(entry) {
  const primary = entry.tracks.get(entry.primaryLang ?? '') ?? [];
  const secondary = entry.secondaryLang ? entry.tracks.get(entry.secondaryLang) ?? [] : [];
  const aligned = secondary.length && primary.length ? alignSecondary(primary, secondary) : null;

  entry.rows = primary.map((segment, index) => ({
    start: segment.start,
    duration: segment.duration,
    text: segment.text,
    secondary: aligned ? aligned[index] : '',
  }));
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
      error: pendingError ?? (trackedTabId === null ? 'No YouTube tab is active.' : null),
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
    error: pendingError ?? entry.error,
  };
}

// --- Preferences ------------------------------------------------------------
// Only the language choice is persisted. Transcripts stay in memory: they are
// large, cheap to refetch, and the worker is kept alive by an open panel.

async function restorePreference() {
  try {
    const stored = await chrome.storage.local.get('secondaryLanguage');
    secondaryPreference = stored?.secondaryLanguage ?? null;
  } catch {
    // Storage is unavailable (or the worker is mid-shutdown). A missing
    // preference is not worth failing startup over.
    secondaryPreference = null;
  }
}

function persistPreference() {
  chrome.storage.local.set({ secondaryLanguage: secondaryPreference }).catch(() => {});
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
void restorePreference();
