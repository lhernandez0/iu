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
  // --- Panel -> service worker (intents) ------------------------------------
  // The worker owns the transcript cache and is the only thing that talks to
  // content scripts, so the panel never needs to know tab ids or track state.
  /** panel -> background — (re)resolve the video and return the whole table. */
  REFRESH: 'refresh',
  /** panel -> background. Payload: { languageCode } */
  SET_PRIMARY: 'set-primary',
  /** panel -> background. Payload: { languageCode | null } */
  SET_SECONDARY: 'set-secondary',
  /** panel -> background. Payload: { seconds } */
  SEEK: 'seek',

  // --- Service worker -> content script -------------------------------------
  /** background -> content — identify the current video WITHOUT fetching
   *  captions. Lets the worker consult its cache before paying for a download. */
  DESCRIBE: 'describe',
  /** background -> content. Payload: { languageCode } — fetch and return a track. */
  PROVIDE: 'provide',
  /** background -> content. Payload: { languageCode } — fetch a specific track. */
  FETCH_TRACK: 'fetch-track',
  /** background -> content. Payload: { seconds } */
  CONTENT_SEEK: 'content-seek',

  // --- Service worker -> panel (state pushes) -------------------------------
  /** background -> panel — the whole table changed; re-render. */
  STATE: 'state',
  /** background -> panel. Payload: { index, seconds } */
  POSITION: 'position',
  /** background -> panel. Payload: { error } */
  ERROR: 'error',

  // --- Content script -> service worker (unsolicited) -----------------------
  /** content -> background. Payload: { index, seconds } */
  CONTENT_POSITION: 'content-position',
  /** content -> background — SPA navigation landed on a different video. */
  CONTENT_VIDEO_CHANGED: 'content-video-changed',

  // --- Parked: audio capture ------------------------------------------------
  /** panel -> background. Payload: { streamId, tabId, tabTitle } */
  START_CAPTURE: 'start-capture',
  /** panel -> background */
  STOP_CAPTURE: 'stop-capture',
  /** offscreen -> panel */
  CAPTURE_STARTED: 'capture-started',
  /** offscreen -> panel */
  CAPTURE_STOPPED: 'capture-stopped',
  /** offscreen -> panel. Payload: { error } */
  CAPTURE_ERROR: 'capture-error',
  /** offscreen -> panel. Payload: { event } — see engines/engine.js */
  ENGINE_EVENT: 'engine-event',
  /** panel -> background -> offscreen. Payload: { muted } — local playback only. */
  SET_MONITOR_MUTED: 'set-monitor-muted',
});
