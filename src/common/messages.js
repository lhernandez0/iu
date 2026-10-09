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
  /**
   * panel -> background. Payload: { languageCode }
   *
   * Remembered as a preference, not just applied to the current video, so the
   * choice survives moving to another one when that language is available there.
   *
   * The STUDY line: the one being learned. Named for its role rather than its
   * position, so it stays meaningful if the layout ever changes.
   */
  SET_STUDY: 'set-study',
  /**
   * panel -> background. Payload: { languageCode | null }
   *
   * The GLOSS line: the one that explains it. Also remembered. `null` means "no
   * second subtitle", which is a preference in its own right rather than the
   * absence of one.
   */
  SET_GLOSS: 'set-gloss',
  /** panel -> background. Payload: { seconds } */
  SEEK: 'seek',

  // --- Settings ---------------------------------------------------------------
  /** panel -> background. Payload: { id, value } — one setting changed. */
  SET_SETTING: 'set-setting',

  // --- Learning layer --------------------------------------------------------
  /** panel -> background. Payload: { listId } — which word list to grade against. */
  SET_LIST: 'set-list',
  /** panel -> background. Payload: { threshold } — lowest level to mark. */
  SET_THRESHOLD: 'set-threshold',
  /** panel -> background. Payload: { word } — ask for a definition on hover. */
  LOOKUP: 'lookup',
  /** background -> panel. Payload: { word, entry } — entry is null when unknown. */
  ENTRY: 'entry',

  // --- Service worker -> content script -------------------------------------
  /** background -> content — identify the current video WITHOUT fetching
   *  captions. Lets the worker consult its cache before paying for a download. */
  DESCRIBE: 'describe',
  /** background -> content. Payload: { languageCode } — fetch and return a track. */
  PROVIDE: 'provide',
  /** background -> content. Payload: { languageCode } — fetch a specific track. */
  FETCH_TRACK: 'fetch-track',
  /**
   * background -> content. Payload: { segments }
   *
   * The transcript the worker already holds, handed over so the content script
   * can report which cue is playing. Needed because position reporting is keyed
   * off the segments it holds, and on a cache hit no fetch happens — so without
   * this a freshly loaded page could never report a cue, and the panel had
   * nothing to follow or scroll to until the next cue change.
   */
  SET_TRACK: 'set-track',
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

  // --- The local video viewer, which is a source we host ---------------------
  /**
   * viewer -> background — "I am a source, and I am this tab". Carries nothing.
   *
   * Exists because our own page cannot be FOUND the way a site is found. The
   * worker resolves a site with `providerFor(tab.url)`, and `tab.url` is empty
   * for a `chrome-extension://` document without the `tabs` permission — which
   * this extension deliberately does not request. So the viewer announces
   * itself instead, and the worker keys off `sender.tab.id`, which is available
   * without any permission.
   *
   * There is deliberately NO `OPEN_VIEWER` message and no `TARGET.VIEWER`: the
   * side panel neither opens the viewer nor knows it exists. The action menu's
   * `contextMenus` handler calls `tabs.create` directly. A panel -> background
   * message here would re-introduce exactly the coupling that design removed.
   *
   * Nor is there a `VIEWER_TRACK`: the viewer does not push segments. The worker
   * asks for them with `PROVIDE`, the same as it does for a website, so there is
   * one code path for getting segments and the viewer is not a special case.
   */
  VIEWER_READY: 'viewer-ready',

  /**
   * viewer -> background — "my content changed, look again". Carries nothing.
   *
   * **Without this the viewer only worked if it was opened BEFORE the side
   * panel.** `VIEWER_READY` fires once, on load, when a freshly opened viewer has
   * no video at all — so the worker resolved an empty source and the panel stayed
   * empty forever after a file was chosen. The file, not the page, is what makes a
   * viewer worth reading.
   *
   * The handler does not need a tab id, which is why nothing is sent: it calls
   * `refresh()`, and `refresh()` resolves whatever the ACTIVE tab is. If the viewer
   * is the tab the user is looking at — which it must be for its video to be the
   * one on screen — then refresh finds it. That sidesteps `sender.tab` entirely,
   * which is not reliably present for an extension page.
   */
  VIEWER_CHANGED: 'viewer-changed',
});
