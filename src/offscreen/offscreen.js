/**
 * Offscreen document — owns the captured MediaStream and the active engine.
 *
 * Coversheet for the whole capture path lives in ../background/service-worker.js.
 * Chrome makes the offscreen document for us; it talks back to the side panel
 * by broadcasting ENGINE_EVENT messages.
 */

import { createEngine } from '../engines/engine.js';
import { MSG, TARGET } from '../common/messages.js';

/** Which engine to use. No real engine exists yet, so 'stub' is the pipeline test. */
const ENGINE_NAME = 'stub';

/** @type {MediaStream | null} */
let stream = null;
/** @type {ReturnType<typeof createEngine> | null} */
let engine = null;
/** @type {HTMLAudioElement | null} */
let monitor = null;
/** @type {() => void} */
let unsubscribe = () => {};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== TARGET.OFFSCREEN) return false;

  if (message.type === MSG.START_CAPTURE) {
    start(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        broadcast({ type: MSG.CAPTURE_ERROR, error: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === MSG.STOP_CAPTURE) {
    stop()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === MSG.SET_MONITOR_MUTED) {
    if (monitor) monitor.muted = Boolean(message.muted);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

/**
 * @param {{ streamId: string, tabTitle?: string }} request
 * @returns {Promise<void>}
 */
async function start({ streamId, tabTitle }) {
  await stop();

  // The stream id minted by the service worker is single-use: calling
  // getUserMedia with it is what actually claims the tab's audio.
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // Chrome requires both of these to accept a tabCapture stream id.
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  // --- Keep the user hearing the tab -----------------------------------------
  // Capturing a tab removes its audio from the normal output path. Routing the
  // captured stream to the speakers restores it; the side panel can mute this
  // monitor without affecting what the engine receives.
  monitor = new Audio();
  monitor.srcObject = stream;
  monitor.autoplay = true;
  await monitor.play().catch((error) => {
    // Autoplay can be blocked without a user gesture; capture still works.
    console.warn('[offscreen] could not start audio monitor', error);
  });

  engine = createEngine(ENGINE_NAME);
  unsubscribe = engine.onEvent((event) => {
    broadcast({ type: MSG.ENGINE_EVENT, event });
  });
  await engine.start(stream);

  broadcast({ type: MSG.CAPTURE_STARTED, tabTitle: tabTitle ?? '' });
}

/** @returns {Promise<void>} */
async function stop() {
  unsubscribe();
  unsubscribe = () => {};
  if (engine) await engine.stop();
  engine = null;
  if (monitor) {
    monitor.srcObject = null;
    monitor = null;
  }
  if (stream) for (const track of stream.getTracks()) track.stop();
  stream = null;
  broadcast({ type: MSG.CAPTURE_STOPPED });
}

/** Broadcast to every extension context; the side panel filters on `target`. */
function broadcast(payload) {
  chrome.runtime
    .sendMessage({ ...payload, target: TARGET.SIDEPANEL })
    .catch(() => {
      // Nothing listening (side panel closed) is not an error.
    });
}
