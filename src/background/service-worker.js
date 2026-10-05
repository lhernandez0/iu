/**
 * Service worker — the only place allowed to call `chrome.tabCapture.getMediaStreamId`.
 *
 * Why the offscreen document: a service worker has no DOM and cannot hold a
 * MediaStream. `tabCapture.capture()` is also service-worker-only. So the
 * worker mints a stream id ($1) and hands it to an offscreen document, which
 * calls `getUserMedia` with that id to obtain the real stream ($2).
 *
 * Sequence:
 *   side panel  --START_CAPTURE { streamId, tabId }-->  worker
 *   worker  -------- ensure offscreen document -------->
 *   worker  -------- starts session + engine --------->  offscreen
 *   offscreen -----> side panel: CAPTURE_STARTED / ENGINE_EVENT / ...
 */

import { MSG, TARGET } from '../common/messages.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/**
 * @typedef {Object} CaptureSession
 * @property {number} tabId
 * @property {string} streamId
 * @property {string} tabTitle
 */

/** @type {CaptureSession | null} */
let session = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== TARGET.BACKGROUND) return false;

  switch (message.type) {
    case MSG.START_CAPTURE:
      startCapture(message)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true; // keep the channel open for the async reply

    case MSG.STOP_CAPTURE:
      stopCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case MSG.SET_MONITOR_MUTED:
      // Pure forward: the offscreen document owns the audio element.
      chrome.runtime
        .sendMessage({ type: MSG.SET_MONITOR_MUTED, target: TARGET.OFFSCREEN, muted: message.muted })
        .catch(() => {});
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

/** Open the side panel when the toolbar icon is clicked. */
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

/** Stop cleanly if the captured tab goes away. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) void stopCapture();
});

/**
 * @param {{ streamId: string, tabId: number, tabTitle?: string }} request
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
