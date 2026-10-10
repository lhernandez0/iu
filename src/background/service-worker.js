/**
 * Service worker, owns the transcript table. Nothing else does.
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
import { defaults, normalise, toStorage, storageKey, definition, SETTINGS_AREA } from '../common/settings.js';
import { providerFor, providerNames } from '../common/providers.js';
import {
  loadDictionary,
  loadIndex,
  dictionaryPathFor,
  levelOf,
  lookup,
  readingOf,
  traditionalOf,
  INDEX_PATH,
} from '../learn/wordlist.js';
import { segmentSegments } from '../learn/segment.js';
import { markLine, listCoversLanguage } from '../learn/marking.js';

/**
 * The extension API namespace.
 *
 * `browser` is the standard and Chrome has had it since 148; `chrome` is what
 * Chrome has always had. Taking whichever exists works in every browser and
 * version we support, with no dependency and no build step.
 *
 * A PREFERENCE, not a fix. A first reading of the compatibility tables said
 * Firefox's `chrome.*` is callback-only, which would have made this mandatory.
 * That is true of Manifest V2 and false of MV3, Mozilla: "In Manifest V3,
 * Firefox supports promises for asynchronous events in the `chrome.*`
 * namespace." Our code is promise-based `chrome.*` throughout, so it already
 * works in Firefox. This is here because one identifier that reads the same
 * everywhere is one fewer thing to know.
 *
 * DECLARED PER FILE rather than imported from a shared module, deliberately.
 * Tried the module first and it broke the test suite: a module is evaluated
 * once and cached, so `api` snapshots whichever global existed at first import,
 * while the test stubs reassign `globalThis.chrome` for every boot, the worker
 * ended up holding a dead stub. Reading the global where it is used cannot go
 * stale. The content script cannot import at all (it is a classic script), so
 * this also keeps one mechanism rather than two. Same shape as MSG and TARGET.
 */
const api = globalThis.browser ?? globalThis.chrome;

/**
 * Whether to log how long each stage of a caption load took.
 *
 * Off, because it printed on every load in everyone's console. It exists because
 * the numbers are occasionally the only way to tell a slow dictionary from a slow
 * network, they need opposite fixes, so removing it outright would mean writing
 * it again the next time that question comes up. Set it in the service worker
 * console: `chrome.storage` is not involved, so this is per-session and cannot be
 * left on by accident.
 */
let TIMING = false;

/**
 * Log a stage's duration, when timing is on.
 *
 * @param {string} stage
 * @param {string} detail
 * @param {number} started  A `Date.now()` taken before the stage.
 */
function reportTiming(stage, detail, started) {
  if (!TIMING) return;
  console.log(`[IU] ${stage}: ${detail} ${Date.now() - started}ms`);
}

// Reachable from the service-worker console, which is the only place these
// numbers are useful. Deliberately not a stored setting: it is a diagnostic, not
// a preference, and a user should never find it on.
globalThis.__iuTiming = (on = true) => {
  TIMING = Boolean(on);
  return `timing ${TIMING ? 'on' : 'off'}`;
};

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
  return api.runtime.getURL(INDEX_PATH);
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
 * interdependent, the threshold is meaningless without the word list, and the
 * word list is meaningless without the dictionary loaded, so keeping them
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
 * triggered the moment a panel connects, which is before an async storage read
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
 * arrive on chrome.runtime.onMessage. Port messages do NOT reach onMessage,
 * they are two separate channels, which is why the panel's own reply(add
 * refresh) is handled here rather than in the switch below.
 *
 * @type {chrome.runtime.Port|null}
 */
let panelPort = null;

api.runtime.onConnect.addListener((port) => {
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
      // Restore this list's own remembered level, or start at the top if the
      // learner has never narrowed THIS list. Not "carry the number over" (it
      // means something else under a different numbering) and not "reset"
      // (which would throw away a choice they made for this list before).
      settings.threshold = thresholdFor(listById(message.listId));
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
      // Remembered against the list it was chosen for. This is the ONLY thing
      // that ever sets a starting level: the learner, once, for this list.
      rememberThreshold(settings.listId, settings.threshold);
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

/** The first level of any list, which is where a learner who has not chosen starts. */
const FIRST_LEVEL = 1;

/**
 * The level to mark from, for a list.
 *
 * The learner's own last choice for THAT list, or the first level if they have
 * never chosen one. Nothing here guesses a starting point on their behalf.
 *
 * It used to be a number carried by the list, and that number was 4 for both HSK
 * lists, the personal level of whoever built this, shipped to everybody. A
 * midpoint of the range is no better: it is still the app deciding, on the
 * learner's behalf, that they are average at a language it has never seen them
 * read. Memory is the honest answer, it can only be wrong until they touch the
 * control once, and after that it is right.
 *
 * Per list rather than global, because a threshold only means something against
 * its own list's numbering.
 *
 * Clamped to the list's own range, because a number from a list with more levels
 * does not mean the same thing in one with fewer.
 *
 * @param {object|undefined} list
 * @returns {number}
 */
function thresholdFor(list) {
  if (!list) return FIRST_LEVEL;
  const remembered = Number(settings.listThresholds?.[list.id]);
  const level = Number.isFinite(remembered) && remembered >= 1 ? remembered : FIRST_LEVEL;
  return Math.min(level, list.levelCount ?? level);
}

/**
 * Record the level the learner chose, against the list they chose it for.
 *
 * The only writer of a starting level. When they switch away and back, this is
 * what `thresholdFor` reads, so a deliberate choice survives a list change
 * without leaking into a list it was never about.
 *
 * @param {string|null|undefined} listId
 * @param {number} level
 */
function rememberThreshold(listId, level) {
  if (!listId) return;
  const number = Number(level);
  if (!Number.isFinite(number) || number < 1) return;
  if (!settings.listThresholds || typeof settings.listThresholds !== 'object') settings.listThresholds = {};
  settings.listThresholds[listId] = Math.floor(number);
}

/**
 * What a level is CALLED in its own list.
 *
 * The stored level is ordered 1..N so the ramp and the threshold comparison are
 * the same for every list, but the NAME differs and it differs in direction: HSK
 * counts 1..9 getting harder, JLPT counts N5..N1 getting harder. So the number is
 * an implementation detail and must never be shown as if it were the name, doing
 * that rendered 私 (JLPT N5, stored 1) as "JLPT 1", which reads as N1, the HARDEST
 * level, on the easiest word in the language.
 *
 * Falls back to the number for a list with no names, so a list that omits them
 * degrades to the old behaviour instead of rendering `undefined`.
 *
 * @param {object|undefined} list
 * @param {number} level  1-based, easiest first.
 * @returns {string}
 */
function levelName(list, level) {
  return list?.levelNames?.[level - 1] ?? String(level);
}

/**
 * A word list by id, or the first available.
 *
 * Resolved from `availableLists` rather than passed around, because the two
 * settings that need it, which list, and what threshold within it, are changed
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
 * Cue times do not tile the timeline, a line ends and the next starts a moment
 * later, so for a fraction of a second after every line nothing is being said.
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
 * a failed second line must not go there, the first line is already correct and
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
 * The dictionary for the ACTIVE language. Loaded lazily, see
 * `ensureDictionaryFor`, and null until then.
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
 * from three places, startup, a list change, and a hover lookup, because any of
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

  // Timed, because this is the suspected cost behind "captions got slow after
  // Japanese". A dictionary is 1.4-3MB of synchronous JSON.parse plus an index
  // build, on the same thread a caption request is waiting on, and the worker is
  // evicted after ~30s idle so it repeats on every wake. Measuring it is what
  // separates that from a slow network, they need opposite fixes.
  //
  // Reporting rather than logging. These numbers were logged unconditionally for
  // a diagnostic that was never concluded, which printed on every caption load in
  // everyone's console. Reachable when someone actually needs to measure again,
  // silent when they do not.
  const started = Date.now();
  dictionary = await loadDictionary(api.runtime.getURL(path));
  dictionaryLanguage = language;
  reportTiming('dictionary load', `${language}`, started);
  return dictionary;
}

/** @type {{tabId: number, streamId: string, tabTitle: string}|null} */
let session = null;

// --- Message routing --------------------------------------------------------

// Both the panel and content scripts address the worker, but on different
// channels: the panel uses its port (see handlePanelMessage above), content
// scripts use chrome.runtime.sendMessage and land here. Panel intents that
// arrive here anyway, the parked capture control below, are handled too, so
// the capture path keeps working whether or not a port is connected.
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== TARGET.BACKGROUND) return false;

  switch (message.type) {
    // --- From content scripts ------------------------------------------------
    case MSG.VIEWER_READY:
      // One of our own sources announcing itself, so the panel resolves it
      // immediately rather than on the next tab switch.
      //
      // The id is taken from `sender.tab` when it is there, and otherwise looked
      // up via `registerOpenViewerTabs()`. **Announcing is not sufficient on its
      // own**: this arrives from a PAGE rather than a content script, and
      // `sender.tab` is not guaranteed for one, so relying on it left the tab
      // unregistered and the panel reporting "no supported video" while the film
      // played.
      if (sender?.tab?.id !== undefined) registeredSources.add(sender.tab.id);
      // NOT awaited, and the listener is NOT async: this callback returns
      // `false`/`true` to control the response channel, and an `async` listener
      // always returns a promise, which Chrome reads as "the response is coming
      // by promise" and would break every other case in this switch.
      //
      // Resolve now, so opening the viewer with the panel already open shows the
      // video without the user having to click back and forth.
      void registerOpenViewerTabs().then(() => refresh());
      return false;

    case MSG.CONTENT_POSITION:
      // Only trusted from the tab the panel is actually showing. A background
      // YouTube tab also reports playback, and its cues are meaningless for the
      // transcript on screen. `sender` is the only way to tell them apart.
      if (sender?.tab?.id !== trackedTabId) return false;

      // Remembered even with no panel attached, so opening one mid-video can
      // start at the live cue rather than at the top of the transcript.
      //
      // `paused` travels with it because the index alone cannot say whether that
      // line is being spoken or is the line that just finished, those are
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

    case MSG.VIEWER_CHANGED:
      // A viewer's content changed, a file was chosen, or a subtitle track was
      // added. No tab id is needed or sent: `refresh()` resolves the active tab,
      // and a viewer whose video matters is by definition the one being looked at.
      //
      // This is what makes the viewer work when the panel was already open. Without
      // it, `VIEWER_READY`, which fires once, on an empty page, was the only
      // notification the worker ever got, so the panel stayed empty no matter what
      // was loaded afterwards.
      void refresh();
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
      api.runtime
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
    // before anything has marked a row, and a lookup that returned nothing for
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
 * the selected one, a word is HSK 4 in 2.0 and HSK 6 in 3.0, and both are true.
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
      out.push({ id: list.id, label: list.label, level, levelName: levelName(list, level), levelCount: list.levelCount });
    }
  }
  return out;
}

/** @param {string} message */
function broadcastError(message) {
  panelPort?.postMessage({ type: MSG.ERROR, error: message });
}

// --- Tab tracking -----------------------------------------------------------

/**
 * Tab ids that announced themselves as one of OUR OWN sources.
 *
 * The local video viewer is a source, but it cannot be FOUND the way a website is
 * found. `providerFor(tab.url)` is how a site is resolved, and `tab.url` is empty
 * for a `chrome-extension://` document without the `tabs` permission, which this
 * extension deliberately does not request, because it would expose the url of
 * every tab the user has open. So the viewer announces itself on load, and the id
 * comes from `sender.tab.id`, which needs no permission.
 *
 * Kept here rather than as a flag on a provider: `providers.js` is URL-match-and
 * inject, and our own page has neither a matchable URL nor anything to inject
 * into. Teaching it about a kind of provider it cannot describe would be worse
 * than a small set in the one place that needs it.
 *
 * @type {Set<number>}
 */
const registeredSources = new Set();

/** The viewer page, as the worker addresses it. */
const VIEWER_PATH = 'src/viewer/viewer.html';

/**
 * Find open viewer tabs and register them.
 *
 * **This exists because relying on the viewer announcing itself is not enough.**
 * The announcement arrives as a `runtime.sendMessage` from a PAGE, not a content
 * script, and `sender.tab` is not guaranteed for an extension page, so the
 * announcement can arrive with nothing to identify the tab. When that happened the
 * tab never registered, so `isReadable` said no, and the panel showed
 * "no supported video is open in the active tab" **while the film played perfectly
 * in the next tab**. Silent, and exactly backwards.
 *
 * `runtime.getContexts({ contextTypes: ['TAB'] })` is the reliable answer, and it
 * needs no permission: it lists the extension's own contexts, and each carries a
 * `tabId`. Filtering on `documentUrl` keeps it to OUR viewer, so another extension
 * page in a tab is not mistaken for a source.
 *
 * It also covers the case the announcement cannot: **reloading the extension
 * restarts the worker with an empty set, while the viewer tab stays open**. Calling
 * this before concluding "nothing is readable" means a viewer tab is found again
 * without the user reopening it.
 *
 * @returns {Promise<number>} How many tabs are registered, for the caller to log
 *   or assert on.
 */
async function registerOpenViewerTabs() {
  if (!api.runtime.getContexts) return registeredSources.size;

  const contexts = await api.runtime
    .getContexts({ contextTypes: ['TAB'] })
    .catch(() => []);

  for (const context of contexts) {
    // `tabId` is -1 when a context is not in a tab, which we cannot address.
    if (typeof context?.tabId !== 'number' || context.tabId < 0) continue;
    const url = context.documentUrl ?? '';
    if (url.endsWith(VIEWER_PATH)) registeredSources.add(context.tabId);
  }

  return registeredSources.size;
}

/**
 * Whether the worker can read this tab: a known site, or one of our own sources.
 *
 * **This exists so the two questions cannot drift apart.** Five places used to ask
 * `providerFor(tab.url)` directly, and every one of them would have answered "no"
 * for the viewer, silently, and in a way that looks correct in the code. A
 * single predicate is what makes "is this tab readable" one decision.
 *
 * @param {{id?: number, url?: string}|null|undefined} tab
 * @returns {boolean}
 */
function isReadable(tab) {
  if (!tab?.id) return false;
  return registeredSources.has(tab.id) || Boolean(providerFor(tab.url));
}

api.tabs.onActivated.addListener(({ tabId }) => {
  void onTabActivated(tabId);
});

api.tabs.onRemoved.addListener((tabId) => {
  // A closed viewer must stop counting as a source, or the set grows for the
  // life of the worker and a later tab reusing the id is wrongly considered
  // readable, which resolves to "no transcript" rather than to "no video".
  registeredSources.delete(tabId);
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
  const tab = await api.tabs.get(tabId).catch(() => null);
  // Our own pages report no usable `url`, so `tabs.get` cannot identify one. Ask
  // the runtime which of our contexts are open before deciding this tab is
  // unreadable, otherwise switching TO the viewer tab does nothing at all, which
  // is exactly what it did.
  if (tab?.id !== undefined && !registeredSources.has(tabId)) await registerOpenViewerTabs();
  if (!isReadable(tab)) return;
  trackedTabId = tabId;
  await refresh();
}

/**
 * A content script says the video in its tab changed.
 *
 * The reporting tab matters. A tab in the background also notices when its video
 * changes, and following that would drag the panel away from what the user is
 * looking at. So the change is only honoured when the tab reporting it is the
 * active one, which is the same rule the rest of this file follows: whatever is
 * in the current tab is what the panel shows.
 *
 * @param {number|null} tabId The tab that reported, from the message sender.
 */
async function onContentVideoChanged(tabId) {
  if (tabId === null) return;

  if (tabId !== trackedTabId) {
    // Adopt it only if it is the tab the user is actually on.
    const [active] = await api.tabs.query({ active: true, currentWindow: true });
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
 * scripts are called on every round trip, so without this, one refresh would
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

api.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
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
 * the manifest-declared scripts are absent too, so without injecting both,
 * every request would come back empty.
 *
 * @param {number} tabId
 * @returns {Promise<number|null>} frameId, or null if there is no such frame.
 */
async function ensureContentScript(tabId) {
  // One of our own pages is never injected into. It is a single document that
  // answers `runtime.onMessage` directly, so `scripting.executeScript` would throw
  // and `webNavigation.getAllFrames` would report no recognised frame for it.
  // `undefined` is the sentinel `sendToContent` reads as "no frame, address the
  // tab itself".
  if (registeredSources.has(tabId)) return undefined;

  const frames = await api.webNavigation.getAllFrames({ tabId }).catch(() => null);
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
      await api.scripting.executeScript({ target, world: 'MAIN', files: [file] });
    }
    for (const file of provider.contentFiles) {
      await api.scripting.executeScript({ target, files: [file] });
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
 *  shows nothing at all, which reads as "broken", with no clue why. */
const CONTENT_TIMEOUT_MS = 4000;

/**
 * The budget for a request whose answer costs a network round trip.
 *
 * The content script answers DESCRIBE, SET_TRACK and CONTENT_SEEK out of
 * memory, so four seconds there only ever means it is wedged. PROVIDE and
 * FETCH_TRACK are different in kind: they download a caption track from
 * YouTube, and PROVIDE may then translate it, one or two real round trips
 * whose duration this extension does not control.
 *
 * Timing those out on the same clock as a local question is a false failure:
 * the fetch was working, and the worker throws away a transcript it was about
 * to receive. That is what a "provide did not answer within 4000ms" report
 * with no further context is, not a broken content script, a slow download.
 *
 * So the slow path gets a budget in the same order as the requests it waits on,
 * and a chart of the two is the reason they are separate constants rather than
 * one.
 */
const CONTENT_FETCH_TIMEOUT_MS = 20000;

/**
 * How long the content script may take to answer this message.
 *
 * @param {object} message
 * @returns {number}
 */
function contentTimeoutFor(message) {
  return message.type === MSG.PROVIDE || message.type === MSG.FETCH_TRACK
    ? CONTENT_FETCH_TIMEOUT_MS
    : CONTENT_TIMEOUT_MS;
}

/**
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<any>}
 */
async function sendToContent(tabId, message) {
  // Our own page needs no injection and has no frame. `undefined` says "send to
  // the tab"; `null` would mean "no readable frame here", which is a different
  // and fatal answer.
  const frameId = await ensureContentScript(tabId);
  if (frameId === null) throw new Error(errorText('CONN001'));

  const timeoutMs = contentTimeoutFor(message);
  let timer = 0;
  try {
    return await Promise.race([
      api.tabs.sendMessage(
        tabId,
        { ...message, target: TARGET.CONTENT },
        frameId === undefined ? {} : { frameId },
      ),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(errorText('CONN002', `${message.type} did not answer within ${timeoutMs}ms`))),
          timeoutMs,
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
  // Before deciding anything: which of our own pages are open. This is the
  // authority on whether a viewer tab is readable, because our own pages report no
  // usable `url`, and it also recovers a viewer tab that was open across an
  // extension reload, when the worker restarts with an empty set.
  await registerOpenViewerTabs();

  if (trackedTabId !== null) {
    // A tracked tab can be closed or navigated away since we last looked. Note
    // that a viewer tab reports NO url, so this test has to go through
    // `isReadable`, asking `providerFor(alive.url)` here would drop the viewer
    // on every single refresh, and the panel would say "no video" while the film
    // was playing in the next tab.
    const alive = await api.tabs.get(trackedTabId).catch(() => null);
    if (!alive || !isReadable(alive)) trackedTabId = null;
  }

  if (trackedTabId === null) {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isReadable(tab)) {
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
    // so without this a freshly loaded page, or a panel opened after a reload,
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
  // supports translation, and it cannot know that from a second round trip.
  //
  // `null` for the study line, always: the line being learned is never machine
  // translated, so the provider is asked for the plain track.
  let provided;
  const fetchStarted = Date.now();
  try {
    provided = await sendToContent(trackedTabId, {
      type: MSG.PROVIDE,
      languageCode: entry.studyLang,
      translateTo: effectiveTranslation(entry, 'study'),
    });
  } catch (error) {
    // Pass-through, so a CONN002 timeout from `sendToContent` survives as itself
    // rather than being relabelled as a caption fault, which is what made this
    // report ambiguous in the first place.
    pendingError = codeError('TRACK003', error);
    broadcastState();
    return;
  }
  reportTiming('caption fetch', `fetched`, fetchStarted);

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
  // may be the same language as the study line, that is how you ask for one
  // language with its translation underneath, and a language-code test would
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
  // against the old one, off by as much as the two transcripts differ.
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
      // below, but never from the settings, so returning to a video that has
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
  // where the cache and the wanted rendering diverge WITHOUT that path running,
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
 * "the text being learned". That conflated two different things, which line
 * carries the learning MARKS, and which line can be TRANSLATED, and forbade a
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
  // track "with translation in mind", the result has to land on a line that
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
 *  key is the oldest, never the video currently on screen. */
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
 * translation on BOTH lines, the original source text was gone. It also meant
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
 * a cache hit nothing is fetched, so a freshly loaded page would report no cue
 * at all until the next cue boundary, which on a paused video never arrives. The
 * panel would then sit at the top of the transcript with nothing highlighted.
 *
 * Not awaited by its callers: it is a notification, and a failure to deliver it
 * is recoverable, the panel still has `activeIndex` in state, and the next
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

  // Already the right rendering, same track AND same translation. A different
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
 * track changes, which discards them, and without this, switching language
 * silently unmarked the whole transcript until a control was touched by hand.
 *
 * The carry-over is conditional on the settings that produced the tokens still
 * being the settings in force. Carrying them over unconditionally was wrong in a
 * way that stayed hidden: a row's tokens encode a (list, threshold) pair, so
 * reusing tokens after the list changed hands back levels from the wrong list.
 * Worse, `applyMarks` treats "every row already has tokens" as "marking is
 * done", so a stale carry-over made that check pass while the marks on screen
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
 * two differ when the stored choice cannot mark what is on screen, HSK 2.0 is
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
 * A threshold is relative to its list, 4 is "upper intermediate" in a 6-level
 * list and something else in a 5-level one, so it cannot be carried across a
 * language switch. When the effective list is the one the learner chose, their
 * stored threshold stands. When it is not (they were on a Chinese list and opened
 * a Japanese video, so JLPT took over), that list's own REMEMBERED level is used
 *, or the top of it if they have never chosen one there.
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
  if (!entry) return Number(settings.threshold) || FIRST_LEVEL;

  const active = activeList(entry);
  if (active && active.id !== settings.listId) return thresholdFor(active);
  return Number(settings.threshold) || FIRST_LEVEL;
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
 * `null` when no video is open, the caller then offers everything, because the
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
  // A language no list covers, an English video, say, leaves the lists empty.
  // Falling back to all of them keeps the control usable and lets `markedReason`
  // explain why nothing is marked, which is more useful than a disabled control
  // with no way to find out why.
  return covering.length ? covering : availableLists;
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
  // achieves. It is wrong the other way, an English line translated INTO Chinese
  // is markable and this would refuse, and it should be replaced by the coverage
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
  // claim marks that are no longer there, which is precisely how the transcript
  // came back unmarked after a language switch.
  const wanted = `${effectiveListId(entry)}:${effectiveThreshold(entry)}`;
  const allMarked = entry.rows.every((row) => Array.isArray(row.tokens));
  if (entry.markedWith === wanted && allMarked) return;

  // Which dictionary holds this list's words, ensuring it is the loaded one.
  // Not a local variable: `ensureDictionaryFor` sets the module-level dictionary,
  // and the marking below reads it, a shadowing local stayed undefined and threw
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
  // the list cannot cover the line at all, English text against a Chinese list,
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
  // different line, or past the end.
  if (activeIndex >= entry.rows.length) {
    activeIndex = -1;
    activePaused = false;
  }

  const segmentStarted = Date.now();
  const tokensPerLine = segmentSegments(
    entry.rows.map((row) => ({ start: row.start, text: row.text })),
    dictionary.headwords,
    dictionary.maxWordLength,
  );

  const threshold = effectiveThreshold(entry);

  entry.rows = entry.rows.map((row, index) => ({
    ...row,
    tokens: markLine(tokensPerLine[index], dictionary, list, threshold, settings.romaji !== 'off'),
  }));
  entry.markedWith = wanted;

  reportTiming('segment+mark', `${entry.rows.length} lines`, segmentStarted);
  broadcastState();
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
    // text, a menu that appears to work and changes nothing.
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
    // broken, "HSK 3.0 does not cover en" is actionable; an unmarked transcript
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
    // not the language you asked for", which the learner needs to know even
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
 * current value *and* the options available right now, and both the list options
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
    // started full every time and the control appeared to do nothing, the setting
    // was stored, broadcast, and then immediately overwritten.
    layout: settings.layout,
    fontSize: settings.fontSize,
    // A presentation choice, but it travels with the state like the others rather
    // than being read from storage by the panel, one owner for settings, and the
    // panel already has the value in hand when it renders.
    markStyle: settings.markStyle,
    // Where a word's reading goes, and how it is written. Sent like the other
    // presentation settings rather than read from storage by the panel, one owner
    // for settings, and the panel has the value in hand when it renders.
    //
    // All three default to their `off`-equivalent, so a viewer who has never
    // touched them gets the panel they had before any of this existed.
    romaji: settings.romaji,
    toneStyle: settings.toneStyle,
    scriptConversion: settings.scriptConversion,
    // The list actually in force, not the raw stored id. A stored value can name
    // a list that no longer exists (data changed under it), one that never did, or
    // one that does not cover this video's language, and reporting the raw id
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
    // Labelled with the list's OWN level names, easiest first, so JLPT reads
    // N5→N1 and HSK reads 1→9. The option VALUE stays the internal number because
    // that is what the threshold comparison uses.
    thresholdOptions: active
      ? Array.from({ length: active.levelCount }, (_, i) => ({ value: i + 1, label: levelName(active, i + 1) }))
      : [],
  };
}

// --- Settings ---------------------------------------------------------------
// One object, one storage key, one place to read and one to write. Adding a
// setting is a change to src/common/settings.js and nothing here.

async function restoreSettings() {
  try {
    const stored = await settingsStore().get(storageKey);
    settings = normalise(stored?.[storageKey]);
  } catch {
    // Storage unavailable, or the worker is mid-shutdown. Defaults are a fine
    // answer and not worth failing startup over.
    settings = defaults();
  }
}

/**
 * Where settings live: the `local` storage bucket.
 *
 * NOT the cross-device bucket, which `manifest.test.mjs` fails the build over,
 * preferences staying on the machine is a documented product promise, not a
 * default that drifted.
 *
 * A function rather than a captured reference, because the area is a property of
 * the environment: a browser that does not offer `sync` should degrade to `local`
 * rather than throw, and reading it at call time is what allows that. The fallback
 * is not expected to run, every target browser has `sync`, but a missing bucket
 * would otherwise crash startup with a TypeError, which is a much worse failure
 * than settings not following the user between machines.
 */
function settingsStore() {
  return api.storage?.[SETTINGS_AREA] ?? api.storage.local;
}

function persistSettings() {
  settingsStore().set(toStorage(settings)).catch(() => {});
}

/**
 * Keep this worker's copy of the settings current when anyone else changes them.
 *
 * **This is what makes `chrome.storage` the source of truth rather than one
 * writer and a cache.** The panel, a future settings page and the video viewer all
 * write to the same bucket, so a change made by one of them has to reach the
 * others, the storage API's own cross-context change event is exactly that
 * mechanism, and it keeps working while this worker is asleep, which a message
 * could not.
 *
 * Without this the worker served its boot-time copy forever: a setting changed in
 * the viewer would be absent from every state push, and the panel would show the
 * value it started the session with.
 *
 * Re-applying the derived side effects matters as much as storing the value. A
 * reading placement changed in the viewer has to rebuild the rows here, or the
 * panel's own view keeps the old annotation despite holding the new setting,
 * which is the same bug the local `applySetting` branch exists to prevent.
 */
api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== SETTINGS_AREA || !changes?.[storageKey]) return;

  const next = normalise(changes[storageKey].newValue);
  // Our own write echoes back here. Rebuilding on it would double every rebuild,
  // so identical values stop here.
  if (JSON.stringify(next) === JSON.stringify(settings)) return;

  const previous = settings;
  settings = next;

  // Rebuild only when something that affects the ROWS moved. A pure presentation
  // change (text size, view mode) is applied by whichever surface made it, and
  // rebuilding here would throw away work for no visible difference.
  const affectsRows = previous.listId !== settings.listId
    || previous.threshold !== settings.threshold
    || previous.romaji !== settings.romaji
    || previous.toneStyle !== settings.toneStyle;

  if (affectsRows) {
    if (previous.listId !== settings.listId) {
      // A different list may be a different language, and `rebuildRows` reads the
      // dictionary synchronously, so the words have to be in hand first or the
      // transcript repaints unmarked and stays that way.
      void ensureDictionaryFor(settings.listId).then(() => {
        rebuildRows(currentEntry());
        broadcastState();
      });
      return;
    }
    rebuildRows(currentEntry());
  }
  broadcastState();
});

/**
 * Apply one setting, doing whatever else that change implies.
 *
 * Most settings are just stored. The ones that need follow-up declare it here,
 * so the panel never has to know which changes are the expensive ones, it
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
      // Moving list restores that list's remembered level rather than carrying a
      // number that has changed meaning.
      settings.threshold = thresholdFor(listById(settings.listId));
      rebuildRows(currentEntry());
      break;

    case 'threshold':
      rememberThreshold(settings.listId, settings.threshold);
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
      // rather than re-choosing. All three settings decide the same thing, what
      // the lines show, so they share a branch.
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
      // rendering is already cached returns immediately, so this is cheap when
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

    case 'romaji':
    case 'toneStyle':
      // The reading is attached to each TOKEN by `markLine`, and the tone style is
      // applied when it is drawn, so a change here has to rebuild the rows, not
      // just repaint them. Without this the setting appeared to do nothing until
      // the next video, because the tokens already in hand carried the old answer.
      //
      // Not the same as `view` or `fontSize`, which are pure presentation and are
      // applied by the panel with nothing to send.
      rebuildRows(currentEntry());
      break;

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
//, which looks, from the panel's side, exactly like nothing happening.

// --- Action -----------------------------------------------------------------

/**
 * Reveal the transcript panel when the toolbar icon is clicked.
 *
 * The ONE genuinely browser-specific call in the extension. Chrome and Firefox
 * provide incompatible sidebar APIs, `sidePanel` with `open()` on one,
 * `sidebarAction` with `toggle()` on the other, and neither implements the
 * other's. This is the whole of the difference on the code side.
 *
 * Feature-detected rather than browser-detected. Sniffing the user agent would
 * be a guess that goes stale; asking whether the API exists is the thing that
 * actually matters, and it stays correct if a browser adds the other one.
 *
 * Firefox's `toggle()` takes no argument because its sidebar is a per-window
 * toggle rather than something a call can open into a specific window, and on a
 * fresh install it starts hidden, so the first click shows it and the second
 * hides it. That is Firefox's own affordance and not something to work around.
 */
api.action.onClicked.addListener((tab) => {
  if (api.sidePanel?.open && tab.windowId !== undefined) {
    api.sidePanel.open({ windowId: tab.windowId });
  } else if (api.sidebarAction?.toggle) {
    void api.sidebarAction.toggle();
  }
});

// --- The action menu: how every source is reached ----------------------------

/**
 * The toolbar icon's own context menu.
 *
 * This is the entry point for sources, not the panel, and that is the point: the
 * panel reads whatever tab is active and knows nothing about where a source came
 * from. A source you open from here is exactly as first-class as one you navigate
 * to, which is what stops local files from being something you discover by
 * failing to find a video.
 *
 * **This costs one permission: `contextMenus`.** An earlier draft of this design
 * claimed it cost none, on the reasoning that `contexts: ['action']` is the
 * action's menu rather than the page context menu. That reasoning is about WHERE
 * the item appears and says nothing about whether the API is available at all,
 * which it is not, without the permission. The claim was wrong, it was approved on
 * that basis, and the item was silently absent until it was fixed.
 *
 * The items are static labels, and that is forced rather than chosen: reading the
 * tab's url or title to say "Use this YouTube video" would need the `tabs`
 * permission, which would expose every tab the user has open. Naming the source
 * generically is the price of not taking that one.
 */
const VIEWER_MENU_ID = 'open-viewer';

/**
 * Create the menu item if it is not already there.
 *
 * Called at module scope rather than only on `onInstalled`, because an unpacked
 * extension reloaded from `chrome://extensions` does not reliably fire that event
 *, and the failure is silent and confusing: the menu is simply absent, with
 * nothing to explain why. A service worker is re-created on every event, so
 * module scope is the one place guaranteed to run.
 *
 * `create` with an id that already exists sets `lastError`. Reading it is what
 * suppresses Chrome's "unchecked runtime.lastError" warning, and the duplicate is
 * expected rather than a fault: the item survives a worker restart, so the second
 * and later wakes find it already present.
 */
function ensureActionMenu() {
  // Feature-detected, not assumed. This runs at module scope, where a throw is
  // fatal to the whole worker, the panel would then get no reply to anything,
  // which looks exactly like the extension not being installed. A browser or an
  // older version without `contextMenus` should lose the menu item, not the
  // entire extension.
  if (!api.contextMenus?.create) return;

  api.contextMenus.create(
    {
      id: VIEWER_MENU_ID,
      title: 'Open video files…',
      // The ACTION's menu, right-clicking the toolbar icon, not the page
      // context menu. The `contextMenus` permission is needed either way; this
      // only decides WHERE the item appears.
      contexts: ['action'],
    },
    () => {
      void api.runtime.lastError;
    },
  );
}

ensureActionMenu();

/**
 * A clean slate on install and update.
 *
 * `removeAll` first makes this idempotent, and matters for a genuine update:
 * without it an item whose title changed between versions would keep the old
 * title, since `create` on an existing id does nothing.
 */
api.runtime.onInstalled.addListener(() => {
  if (!api.contextMenus?.removeAll) return;
  api.contextMenus.removeAll(() => {
    void api.runtime.lastError;
    ensureActionMenu();
  });
});

if (api.contextMenus?.onClicked) {
  api.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== VIEWER_MENU_ID) return;
    // `tabs.create` needs no permission, and the URL is ours. The viewer then
    // announces itself, so the worker never has to match it by url.
    void api.tabs.create({ url: api.runtime.getURL('src/viewer/viewer.html') });
  });
}

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

  await api.runtime.sendMessage({
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
  await api.runtime.sendMessage({ type: MSG.STOP_CAPTURE, target: TARGET.OFFSCREEN }).catch(() => {
    // Offscreen document may already be gone, that is a valid stopped state.
  });
}

/** @returns {Promise<void>} */
async function ensureOffscreenDocument() {
  const url = api.runtime.getURL(OFFSCREEN_PATH);
  const existing = await api.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (existing.length > 0) return;

  // `offscreen.createDocument` rejects if another call raced us here; swallow it.
  await api.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [api.offscreen.Reason.USER_MEDIA],
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
 * nothing until one of its lists is actually selected, with one language this
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
    // "Widest" means widest in the PRIMARY language, the first the index
    // declares, not widest overall. With one language those were the same
    // thing; with two they are not. JLPT places 11,158 words and HSK 3.0 places
    // 10,969, so widest-overall silently made Japanese the default for every new
    // user, and on a Chinese video that list covers nothing, which is the exact
    // unmarked-transcript symptom the widest-list rule was added to remove.
    const primaryLanguage = availableLists[0]?.language;
    const primary = availableLists.filter((list) => list.language === primaryLanguage);
    const widest = [...primary].sort((a, b) => (b.levelled ?? 0) - (a.levelled ?? 0))[0];

    if (!settings.listId || !availableLists.some((list) => list.id === settings.listId)) {
      settings.listId = widest?.id ?? null;
      // Remembered if they have used this list before, otherwise the first level.
      settings.threshold = thresholdFor(widest);
    }

    // Broadcast NOW, before loading any words. The picks can be populated and the
    // panel is told what exists; making that wait on a 1.4-3 MB parse would leave
    // the dropdown empty for however long that takes. The words follow below and
    // broadcast again when the rows can actually be marked.
    broadcastState();
    rebuildRows(currentEntry());

    // Deliberately NOT loading the dictionary here.
    //
    // This used to be `await ensureDictionaryFor(settings.listId)`, which parses
    // the language of the STORED or DEFAULT list, Chinese, on a fresh install.
    // The marking path then parses the language of the VIDEO, which may be the
    // other one. So a Japanese video made the worker parse BOTH bundled files:
    // 1.4MB of Chinese it would never read, then 3MB of Japanese it needed. That
    // is 4.4MB where the budget before Japanese existed was 1.4MB.
    //
    // It is synchronous JSON.parse plus an index build on the same thread the
    // caption request is waiting on, and an MV3 worker is evicted after ~30s idle
    // so it repeats on every wake. `applyMarks` loads the dictionary it actually
    // needs and is already deferred, so the eager call had no viewer.
  } catch (error) {
    broadcastError(codeError('DICT001', error));
  }
  broadcastState();

  // Mark whatever is already on screen. The transcript usually arrives before
  // the word list does, so without this the rows would sit unmarked until
  // something else happened to rebuild them.
  rebuildRows(currentEntry());
}
