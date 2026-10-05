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

/** @typedef {'background' | 'offscreen' | 'sidepanel'} MessageTarget */

export const TARGET = Object.freeze({
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
  SIDEPANEL: 'sidepanel',
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
});
