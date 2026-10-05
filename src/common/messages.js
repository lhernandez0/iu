/**
 * Message contract shared by every extension context.
 *
 * `chrome.runtime.sendMessage` broadcasts to *all* extension contexts, so every
 * message carries an explicit `target` and every listener ignores anything not
 * addressed to it. Keep this tuple the single source of truth — the service
 * worker, offscreen document and side panel all import it.
 *
 * Shape:
 *   { type: MSG.*, target: TARGET.*, ...payload }
 */

/** @typedef {'background' | 'offscreen' | 'sidepanel' | 'content'} MessageTarget */

export const TARGET = Object.freeze({
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
  SIDEPANEL: 'sidepanel',
  CONTENT: 'content',
});

export const MSG = Object.freeze({
  /** sidepanel -> background. Payload: { streamId, tabId, tabTitle } */
  START_CAPTURE: 'start-capture',
  /** sidepanel -> background */
  STOP_CAPTURE: 'stop-capture',
  /** offscreen -> sidepanel */
  CAPTURE_STARTED: 'capture-started',
  /** offscreen -> sidepanel */
  CAPTURE_STOPPED: 'capture-stopped',
  /** offscreen -> sidepanel. Payload: { error } */
  CAPTURE_ERROR: 'capture-error',
  /** offscreen -> sidepanel. Payload: { event } — see engines/engine.js */
  ENGINE_EVENT: 'engine-event',
  /** sidepanel -> background -> offscreen. Payload: { muted } — local playback only. */
  SET_MONITOR_MUTED: 'set-monitor-muted',

  // --- Captions phase -------------------------------------------------------
  // NOTE: content scripts are injected as CLASSIC scripts and cannot
  // `import`, so src/content/youtube-content.js repeats these names as string
  // literals. Change one, change the other.
  /** sidepanel -> content. Payload: { languageCode? } */
  GET_TRANSCRIPT: 'get-transcript',
  /** sidepanel -> content. Payload: { seconds } */
  SEEK: 'seek',
  /** sidepanel -> content. Payload: { languageCode } */
  SELECT_TRACK: 'select-track',
  /** sidepanel -> content — read the video's current playback position. */
  GET_POSITION: 'get-position',
  /** content -> sidepanel. Payload: { index, seconds } — the active segment changed. */
  POSITION: 'position',
  /** content -> sidepanel — the video changed, the transcript is stale. */
  TRANSCRIPT_INVALIDATED: 'transcript-invalidated',
});
