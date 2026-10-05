/**
 * Parked audio-capture path.
 *
 * This is the tabCapture side of the extension, extracted from the panel so it
 * stays reachable (and correct) while the captions phase is active. Flip
 * `USE_AUDIO_CAPTURE` in sidepanel.js to wire it back up.
 *
 * UNVERIFIED: the stream id below is minted from the side-panel context. The
 * original scaffold did the same, but that path was never exercised in a
 * browser. If `getMediaStreamId` turns out to require the service worker
 * (as `tabCapture.capture()` does), move this call into
 * src/background/service-worker.js and have it return the id. The offscreen
 * document's half of the protocol is unaffected either way.
 */

import { MSG, TARGET } from '../common/messages.js';

/** @returns {Promise<void>} */
export async function startAudioCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab to capture.');

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const reply = await chrome.runtime.sendMessage({
    type: MSG.START_CAPTURE,
    target: TARGET.BACKGROUND,
    streamId,
    tabId: tab.id,
    tabTitle: tab.title ?? '',
  });
  if (!reply?.ok) throw new Error(reply?.error ?? 'Capture failed.');
}

/** @returns {Promise<void>} */
export async function stopAudioCapture() {
  await chrome.runtime.sendMessage({ type: MSG.STOP_CAPTURE, target: TARGET.BACKGROUND }).catch(() => {});
}
