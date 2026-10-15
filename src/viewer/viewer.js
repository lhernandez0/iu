/**
 * The video viewer, a SOURCE, one we host.
 *
 * It speaks the same five messages as the YouTube content script, with the same
 * shapes, and nothing else:
 *
 *   DESCRIBE      what video is this, and what subtitle tracks does it have
 *   PROVIDE       give me the segments for one track
 *   FETCH_TRACK   the same, for a specific track the worker names
 *   SET_TRACK     here are segments the worker already holds, so report position
 *   CONTENT_SEEK  move playback to this many seconds
 *
 * and it reports CONTENT_POSITION as playback advances. VIEWER_READY and
 * VIEWER_CHANGED announce it on load and when a file is chosen.
 *
 * The service worker does not know this page exists. It finds it because the page
 * announces itself, because `tab.url` is empty for a `chrome-extension://` document
 * without the `tabs` permission, which this extension deliberately does not
 * request. Everything else is the ordinary content contract, which is why the
 * panel, the row model and the alignment need no changes to read a file instead of
 * a website.
 *
 * A MODULE rather than a classic script, unlike the content scripts. Those are
 * injected into a page that does not trust us and cannot `import`; this is our own
 * document, so it can import the shared marking module and read the canonical
 * message names from `messages.js` instead of duplicating them.
 *
 * ## What this file owns, and what it does not
 *
 * It owns playback, the control bar, the captions, and the file/track model. It does
 * NOT own the mark RULES, `src/learn/marking.js` does, shared with the worker, so
 * the captions and the panel's transcript cannot disagree about what a mark is. It
 * does not own the mark LOOK, `src/common/marks.css` does, for the same reason.
 */

import { MSG, TARGET } from '../common/messages.js';
import { errorText } from '../common/errors.js';
import { findActiveIndex, findPlayingIndex, captionHoldSeconds, alignSecondary } from '../common/transcript.js';
import { parseSubtitles, languageFromFileName, SUBTITLE_EXTENSIONS } from './subtitles.js';
import { readMatroskaTracks, readMatroska, imageCodecName } from './matroska.js';
import { segment } from '../learn/segment.js';
import { indexDictionary, loadIndex, dictionaryPathFor, lookup, levelOf, levelColour } from '../learn/wordlist.js';
import { markLine, listCoversLanguage, listForLanguage } from '../learn/marking.js';
import { SETTINGS_AREA, storageKey as SETTINGS_KEY, CAPTION_FADE_DEFAULT, CAPTION_FADE_MIN, CAPTION_FADE_MAX } from '../common/settings.js';
import { renderReading, setReadingSettings, attachHover, showEntry, hide as hidePopover } from '../common/marks.js';
import { audioTracksSupported, listAudioTracks, streamTrack } from './audio-tracks.js';
import { transcodeForElement } from './decode-encode.js';
import { logBanner, logFile, logAudioTracks, logSubtitle, logEmbeddedTracks, logDecoder, logSubs } from './diagnostics.js';

/**
 * The extension API namespace, `browser` where it exists (Chrome 148+ and always
 * in Firefox), `chrome` otherwise. Read here rather than imported so it reads the
 * global where it is used; a module would snapshot it at import time and the test
 * stubs reassign the global.
 */
const api = globalThis.browser ?? globalThis.chrome;

const els = {
  video: /** @type {HTMLVideoElement} */ (document.getElementById('video')),
  stage: /** @type {HTMLElement} */ (document.getElementById('stage')),
  picture: /** @type {HTMLElement} */ (document.getElementById('picture')),
  bar: /** @type {HTMLElement} */ (document.getElementById('bar')),
  pickFiles: /** @type {HTMLInputElement} */ (document.getElementById('pick-files')),
  chosen: /** @type {HTMLElement} */ (document.getElementById('chosen')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  placeholder: /** @type {HTMLElement} */ (document.getElementById('placeholder')),
  resume: /** @type {HTMLElement} */ (document.getElementById('resume')),
  resumeText: /** @type {HTMLElement} */ (document.getElementById('resume-text')),
  captionRow: /** @type {HTMLElement} */ (document.getElementById('caption-row')),
  overlay: /** @type {HTMLElement} */ (document.getElementById('captions-overlay')),
  below: /** @type {HTMLElement} */ (document.getElementById('captions-below')),
  overlayPrimary: /** @type {HTMLElement} */ (document.getElementById('caption-primary')),
  overlaySecondary: /** @type {HTMLElement} */ (document.getElementById('caption-secondary')),
  belowPrimary: /** @type {HTMLElement} */ (document.getElementById('caption-primary-below')),
  belowSecondary: /** @type {HTMLElement} */ (document.getElementById('caption-secondary-below')),
  scrubber: /** @type {HTMLInputElement} */ (document.getElementById('scrubber')),
  cues: /** @type {HTMLElement} */ (document.getElementById('cues')),
  timeCurrent: /** @type {HTMLElement} */ (document.getElementById('time-current')),
  timeDuration: /** @type {HTMLElement} */ (document.getElementById('time-duration')),
  muteButton: /** @type {HTMLButtonElement} */ (document.getElementById('mute')),
  volumeSlider: /** @type {HTMLInputElement} */ (document.getElementById('volume')),
  difficultyButton: /** @type {HTMLButtonElement} */ (document.getElementById('difficulty')),
  fullscreenButton: /** @type {HTMLButtonElement} */ (document.getElementById('fullscreen')),
  audioField: /** @type {HTMLElement} */ (document.getElementById('audio-field')),
  audioSelect: /** @type {HTMLSelectElement} */ (document.getElementById('audio-track')),
  audioNote: /** @type {HTMLElement} */ (document.getElementById('audio-note')),
};

// --- Settings ----------------------------------------------------------------
//
// Read directly from `chrome.storage`, because this is our own page and storage is
// the SOURCE OF TRUTH, the same arrangement the worker subscribes to. Writing goes
// the same way, so a change made here and a change made in the panel both land in
// the bucket and both reach every listener, including the worker's.
//
// The bucket and key come from `settings.js` so there is one definition of where
// settings live. The viewer does NOT import the registry's `defaults()`, it needs
// six values and renders none of them as controls, and importing the whole thing
// would pull in every option list for no use. The KEYS are the contract.
//
// **Every write is a MERGE, never a whole-object replace.** The viewer knows about
// six settings; the panel has fourteen. Writing `settings` wholesale would delete
// every one the viewer had never heard of, the word list, the threshold, the text
// size, the moment anyone touched a caption control. So the bucket is read, the one
// key is set, and the rest is carried across untouched.

const DEFAULTS = {
  captionsOn: true,
  captionPlacement: 'overlay',
  romaji: 'above',
  toneStyle: 'marks',
  markStyle: 'underline',
  defaultSpeed: '1',
  captionSize: 20,
  // How long a finished subtitle holds before fading, in seconds. Viewer-only: the
  // panel's rows stay put on purpose, so a gap in a film's subtitles does NOT apply.
  captionFade: CAPTION_FADE_DEFAULT,
  // Whether the difficulty band is drawn under the scrubber. Viewer-only, and in the
  // registry because it is a preference that persists, unlike volume, which the
  // element keeps on its own and which the OS volume should really own.
  difficulty: true,
  // SHARED with the panel, not viewer-owned. The word list, the threshold and the two
  // subtitle tracks are one preference each: the viewer draws the same transcript the
  // panel does, over the video instead of beside it, so a learner picking HSK 2.0 and
  // a Chinese track expects both surfaces to honour it.
  listId: null,
  threshold: null,
  studyLanguage: null,
  glossLanguage: null,
};

/** @type {Record<string, any>} */
let settings = { ...DEFAULTS };

/** Applied at load and whenever the bucket changes, from any context. */
function applyStoredSettings(stored) {
  if (!stored || typeof stored !== 'object') return;
  const next = { ...settings };
  if (typeof stored.captionsOn === 'boolean') next.captionsOn = stored.captionsOn;
  if (['overlay', 'below'].includes(stored.captionPlacement)) next.captionPlacement = stored.captionPlacement;
  if (['off', 'above', 'below', 'marked'].includes(stored.romaji)) next.romaji = stored.romaji;
  if (['marks', 'numbers'].includes(stored.toneStyle)) next.toneStyle = stored.toneStyle;
  if (['underline', 'highlight'].includes(stored.markStyle)) next.markStyle = stored.markStyle;
  if (['0.125', '0.25', '0.5', '0.75', '1', '1.25', '1.5', '2', '3', '4', '6', '8'].includes(String(stored.defaultSpeed))) {
    next.defaultSpeed = String(stored.defaultSpeed);
  }
  const size = Number(stored.captionSize);
  if (Number.isFinite(size)) next.captionSize = Math.min(34, Math.max(12, Math.round(size)));
  // Clamped the same way the registry does, so a hand-edited bucket cannot store a
  // hold of a thousand seconds and leave a subtitle up for the rest of the film.
  const fade = Number(stored.captionFade);
  if (Number.isFinite(fade)) {
    next.captionFade = Math.min(CAPTION_FADE_MAX, Math.max(CAPTION_FADE_MIN, Math.round(fade * 10) / 10));
  }
  if (typeof stored.difficulty === 'boolean') next.difficulty = stored.difficulty;
  // The shared preferences, read the same way the panel reads them.
  next.listId = typeof stored.listId === 'string' && stored.listId ? stored.listId : null;
  const level = Number(stored.threshold);
  next.threshold = Number.isFinite(level) && level >= 1 ? Math.floor(level) : null;
  next.studyLanguage = typeof stored.studyLanguage === 'string' && stored.studyLanguage ? stored.studyLanguage : null;
  next.glossLanguage = typeof stored.glossLanguage === 'string' && stored.glossLanguage ? stored.glossLanguage : null;
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  settings = next;
  if (changed) {
    applySettings();
    // The marks are attached at marking time, so a change to how they look or what
    // they show needs the rows re-marked, not just repainted.
    markSegments();
  }
}

void api.storage[SETTINGS_AREA]
  .get(SETTINGS_KEY)
  .then((stored) => applyStoredSettings(stored?.[SETTINGS_KEY]))
  .catch(() => {});

// **This is what makes the viewer and the panel agree.** The panel writes a
// setting, the bucket changes, and this listener fires, because the storage API's
// change event is cross-context. Without it a caption placement changed in the
// panel would not reach the video, and the two would disagree until a reload.
api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== SETTINGS_AREA || !changes?.[SETTINGS_KEY]) return;
  applyStoredSettings(changes[SETTINGS_KEY].newValue);
});

/**
 * Write ONE setting, merged over whatever the bucket already holds.
 *
 * Read-modify-write, because the alternatives are both wrong: replacing the whole
 * object deletes every setting this page does not know about, and keeping a
 * long-lived copy to write back would clobber a change the panel made in between.
 * The read is cheap and the merge is exact.
 *
 * @param {string} id
 * @param {any} value
 */
async function setSetting(id, value) {
  settings[id] = value;
  applySettings();
  // A list change can mean a different DICTIONARY, so it goes through the same
  // load path rather than re-marking against words for another language. Everything
  // else only changes how the existing marks are drawn.
  if (id === 'listId') void prepareMarks(trackLanguage());
  // `difficulty` only changes how the band is DRAWN, not what is marked, and
  // `applySettings` above has already repainted it. Re-marking every cue of a film to
  // toggle a decoration would be real work for no result.
  else if (id !== 'difficulty') markSegments();
  try {
    const stored = await api.storage[SETTINGS_AREA].get(SETTINGS_KEY);
    const merged = { ...(stored?.[SETTINGS_KEY] ?? {}), [id]: value };
    await api.storage[SETTINGS_AREA].set({ [SETTINGS_KEY]: merged });
  } catch {
    // Storage unavailable. The change still applies on screen and will be lost on
    // reload, which is better than refusing the control.
  }
}

// --- Marking -----------------------------------------------------------------
//
// The captions are marked with the SAME rules the panel's transcript uses
// (`src/learn/marking.js`) over the same dictionary, so a word looks the same in
// both places. This is the viewer's own copy of the dictionary load, it does not
// ask the worker, because the viewer is a source, not a client of one, and a round
// trip per caption would be a message per cue.

/** @type {object|null} */
let listIndex = null;
/** Which list is being graded against. */
let listId = null;

/** @param {string} path */
function loadJson(path) {
  return fetch(path).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
    return response.json();
  });
}

/**
 * Load the dictionary and mark every cue.
 *
 * Fire-and-forget: the captions render UNMARKED first and gain their marks when the
 * dictionary arrives. That ordering is deliberate, a subtitle track that appears a
 * beat late is a bug, and one that appears plain and then gains underlines is the
 * intended behaviour of an annotation. The same order the panel uses.
 *
 * Called once per file, AFTER the track is known, because the list is chosen from the
 * track's language. Called before that, it picked a list for no language and marked
 * nothing.
 *
 * @param {string|null} languageCode The language of the track now on screen.
 */
async function prepareMarks(languageCode) {
  try {
    if (!listIndex) listIndex = await loadIndex(api.runtime.getURL('src/learn/data/index.json'));
    // The list is an explicit choice when there is one, and the track's language
    // otherwise, the same resolution the pickers show, through `resolvedList`, so
    // the control and the marking cannot disagree.
    void languageCode;
    const list = resolvedList();
    if (!list) return;
    listId = list.id;
    // A different language can mean a different dictionary, so it is reloaded rather
    // than reused, the alternative marks Japanese text against Chinese headwords.
    if (dictionaryLanguage !== list.language) {
      const path = dictionaryPathFor(listIndex, listId);
      if (!path) return;
      dictionary = indexDictionary(await loadJson(api.runtime.getURL(path)));
      dictionaryLanguage = list.language;
    }
    markSegments();
  } catch {
    // No dictionary is not a failure of playback. The captions show plain text,
    // which is a perfectly good subtitle, and that is the honest degradation.
  }
}

/** Which language the loaded dictionary holds, so a track change reloads it. */
let dictionaryLanguage = null;

/** @type {object|null} */
let dictionary = null;

/**
 * Mark every cue, in place.
 *
 * Stores the TOKENS on each cue so a re-mark does not re-segment, segmentation is
 * the expensive half and it does not depend on the settings, only on the text.
 */
function markSegments() {
  if (!dictionary || !segments.length) return;

  const list = resolvedList();
  // A list that cannot grade this language would find nothing and render the
  // captions plain with no explanation, which reads as a broken feature. Skipping
  // the work says the same thing more cheaply, and the captions being plain for a
  // language we have no list for is correct, not a failure.
  if (!listCoversLanguage(list, trackLanguage())) return;

  const withReading = settings.romaji !== 'off';

  for (const cue of segments) {
    if (!cue.tokens) {
      // `segment` already sets `known` per token from the headword set, so the
      // output goes straight to `markLine` with nothing rewritten in between.
      cue.tokens = segment(cue.text, dictionary.headwords, dictionary.maxWordLength);
    }
    cue.marked = markLine(cue.tokens, dictionary, list, thresholdFor(list), withReading);
  }

  redrawCaptions();
  // The band is painted FROM these marks, so it has to be repainted when they change,
  // otherwise switching word list or threshold recolours every word and leaves the
  // timeline showing the levels of the previous list.
  paintDifficulty();
}

/**
 * The level to mark from, for a list.
 *
 * The first level, matching the panel's own default when the learner has not
 * chosen: nothing is guessed about their ability. The viewer has no threshold
 * control, that is a panel-side setting, so it marks from the bottom, which
 * underlines the most and hides the least.
 *
 * @param {object|null} list
 */
function thresholdFor(list) {
  const chosen = Number(settings.threshold);
  if (!Number.isFinite(chosen) || chosen < 1) return 1;
  // Clamped to the list's own range: a level from a list with more levels does not
  // mean the same thing in one with fewer.
  return Math.min(chosen, list?.levelCount ?? chosen);
}

/**
 * The language of the track the captions are drawn from.
 *
 * A viewer has one subtitle track on screen, unlike the panel which has two, so the
 * list to grade against follows from this and nothing else. `und` means the file did
 * not tag the track, which is common and not a reason to refuse to mark.
 */
function trackLanguage() {
  return activeTrackLanguage ?? tracks[0]?.languageCode ?? null;
}

// --- State ------------------------------------------------------------------

/**
 * The current video file, if one has been chosen.
 *
 * Held so `DESCRIBE` can rebuild the descriptor without re-reading anything, and so
 * a second subtitle file added later does not lose the video.
 *
 * @type {File|null}
 */
let videoFile = null;

/**
 * The blob URL for `videoFile`, kept so it can be revoked.
 *
 * **Leaking these is a real leak.** A blob URL pins its backing file until revoked,
 * so picking a 4GB film and then another holds both in memory until the tab closes.
 * Every replacement revokes the previous URL.
 *
 * @type {string|null}
 */
let videoObjectUrl = null;

/**
 * Every subtitle track available, in the order they were found.
 *
 * Two sources feed this and the entries differ only in how their cues are produced,
 * which is what makes an embedded track and a sidecar look identical downstream:
 *
 *   - a SIDECAR file, parsed at pick time (cheap, it is a text file)
 *   - a track INSIDE the video, extracted lazily on first request (not cheap, it
 *     walks the media, so a film's cues are read when a language is chosen)
 *
 * @type {Array<object>}
 */
let tracks = [];

/** @type {object[]} */
let segments = [];

/**
 * The GLOSS line's text, aligned cue-for-cue to `segments`.
 *
 * A local file can carry more than one subtitle track, a Chinese traditional and an
 * English, say, so the viewer draws both lines exactly as the panel does. Alignment
 * is by START TIME with a drift tolerance, through the shared `alignSecondary`, so a
 * badly out-of-sync second track is left blank rather than paired with the wrong
 * line. That is the same guarantee the panel's dual subtitles have, and it comes from
 * the same function rather than a second implementation.
 *
 * @type {string[]}
 */
let glossLines = [];

/** What the worker last told us it is showing, so position is measured against it. */
let activeTrackLanguage = null;

/** Dedupe sentinel for position reporting. `-2` forces the next report to fire. */
let lastIndex = -2;
let lastPaused = false;

// --- Small helpers ----------------------------------------------------------

/** @param {string} text @param {boolean} [isError] */
function setStatus(text, isError = false) {
  // A healthy file has nothing to say. "Ready." and "3 subtitle tracks in this video"
  // were the bar narrating what the viewer can already see, which is what the status
  // line spent most of its life doing. It is an ERROR channel now: visible when
  // something is wrong, empty and collapsed otherwise.
  const message = isError ? text : '';
  els.status.textContent = message;
  els.status.hidden = !message;
  els.status.classList.toggle('error', isError);
}

/** @param {File} file */
function isVideoFile(file) {
  const name = file.name.toLowerCase();
  return file.type.startsWith('video/') || name.endsWith('.mkv') || name.endsWith('.mp4') || name.endsWith('.webm');
}

/** @param {File} file */
function isSubtitleFile(file) {
  const name = file.name.toLowerCase();
  return SUBTITLE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * A stable identity for a file, for the worker's cache key and the resume store.
 *
 * Name, size and modification time together. Deliberately NOT the blob URL: that
 * changes on every pick, so the cache would miss every time and the worker's
 * tracked-video set would grow without bound.
 *
 * @param {File} file
 */
function videoIdFor(file) {
  return `local:${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * A bounded `read(offset, length)` over a `File`, for the Matroska parser.
 *
 * `File.slice()` does not read anything, it is a view, and the `arrayBuffer()` it
 * returns reads only that slice. So a multi-gigabyte film costs one window at a
 * time and never the whole file.
 *
 * @param {File} file
 */
function viewerFor(file) {
  return {
    size: file.size,
    read: async (offset, length) => {
      const end = Math.min(offset + length, file.size);
      const buffer = await file.slice(offset, end).arrayBuffer();
      // Counted, not logged. A film's cues are walked cluster by cluster, so this fires
      // thousands of times; the totals are reported once by `extract-done` instead, which
      // keeps the log readable while still saying how much was read.
      window.__cuesRead = (window.__cuesRead ?? 0) + buffer.byteLength;
      window.__cuesReads = (window.__cuesReads ?? 0) + 1;
      return new Uint8Array(buffer);
    },
  };
}

/**
 * The descriptor the worker's `DESCRIBE` expects.
 *
 * `trackList` entries are what the panel's language dropdowns render, so its shape
 * is the contract, not a presentation choice.
 */
function describeVideo() {
  if (!videoFile) {
    return { videoId: '', title: '', isLive: false, trackList: [], translationLanguages: [] };
  }
  return {
    videoId: videoIdFor(videoFile),
    title: videoFile.name,
    isLive: false,
    // One entry per subtitle track, from the container or a sidecar. A track that
    // cannot be read still appears, because a language that is present but unusable
    // is worth showing with its reason attached rather than vanishing silently.
    trackList: tracks.map((track) => ({
      languageCode: track.languageCode,
      name: track.name || track.languageCode,
      // `isTranslatable: false` for every local track: translating a local file
      // would need a network request, which the extension does not make.
      isTranslatable: false,
      kind: track.codec ?? null,
    })),
    translationLanguages: [],
  };
}

// --- Choosing files ---------------------------------------------------------

/** @param {FileList|File[]} files */
async function acceptFiles(files) {
  const list = [...files];
  if (!list.length) return;

  const video = list.find(isVideoFile);
  const subs = list.filter(isSubtitleFile);

  if (video) await loadVideo(video);
  if (subs.length) await loadSubtitles(subs);

  if (!video && !subs.length) {
    setStatus(errorText('VIEWER002', 'no video or subtitle file in that selection'), true);
    return;
  }
  render();

  // Tell the worker there is something to read now. This is what makes the viewer
  // work when the side panel was ALREADY open: `VIEWER_READY` fired once, on an
  // empty page, so without this the worker never learned a file had been chosen and
  // the panel stayed blank while the film played.
  notifyChanged();
}

/**
 * "Look again", the viewer's content changed.
 *
 * Sent fire-and-forget: the worker resolves the active tab, so there is nothing to
 * retry against and nothing to report if it is missed. The next cue change or the
 * next `DESCRIBE` recovers.
 */
function notifyChanged() {
  void api.runtime
    .sendMessage({ type: MSG.VIEWER_CHANGED, target: TARGET.BACKGROUND })
    .catch(() => {});
}

/**
 * Open a video file, and find whatever subtitles it carries.
 *
 * `async` because discovery reads the container. It is cheap, only the `Tracks`
 * element, but it is a read, and the video must be usable while it happens, so
 * playback starts first and the track list fills in after.
 *
 * @param {File} file
 */
async function loadVideo(file) {
  // A stream from the previous file has to be torn down before its source goes away,
  // or its MediaSource stays attached and its object URL keeps the blob alive.
  // `releaseStream` revokes whichever stream is live, the remux rebuild OR the
  // transcode, so this must NOT revoke `videoObjectUrl` as well: after a switch that
  // variable holds the SAME MediaSource URL, and revoking it twice detaches a source
  // the element may still be reading.
  if (releaseStream) {
    releaseStream();
    releaseStream = null;
  } else if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl);
  }
  // The transcode handle belongs to the file just closed. `releaseStream` already ran
  // its `revoke`; this only drops our reference so a stale `done` cannot be awaited.
  transcodeStream = null;

  videoFile = file;
  videoObjectUrl = URL.createObjectURL(file);
  els.video.src = videoObjectUrl;
  els.video.load();
  els.placeholder.hidden = true;
  // A new file has no cues yet, so the captions would be showing the previous
  // film's last line. Cleared here rather than in the metadata handler, which fires
  // after the first frame has already been drawn.
  segments = [];
  glossLines = [];
  // And the TRACK LIST goes with them, which is not obvious and was a real bug: a
  // track belongs to the FILE it came from, so keeping this list across an open
  // leaves the previous file's sidecar subtitles in the Line 1 / Line 2 dropdowns
  // even though their cues were just cleared. Picking one then does nothing, since
  // its segments are gone, and the control offers languages the new file does not
  // have.
  //
  // Seen on the demo page: it opens a clip with three `.srt` sidecars, and opening
  // your own file afterwards still listed `demo.en.srt`, `demo.zh-Hans.srt` and
  // `demo.zh-Hant.srt` beside your own track. Cleared for EVERY new video, so the
  // list is always exactly what the current file carries, sidecar or embedded.
  //
  // `activeTrackLanguage` goes too, or `trackLanguage()` falls back through a
  // language that is no longer in the list and the marking picks the wrong
  // dictionary until a track is chosen.
  tracks = [];
  activeTrackLanguage = null;
  // The cue passes belong to the file just replaced, so they are dropped. A new open runs
  // the bounded first pass again, for the new file's tracks. See `readCuesFirstPass`.
  cuesByNumber = new Map();
  cuesWindowed = false;
  firstPassPromise = null;
  fillPassPromise = null;
  redrawCaptions();
  // A real open, so the offer is wanted. Set explicitly rather than left to the flag's
  // default, because a previous switch may have consumed it and a previous switch that
  // did NOT fire metadata would leave it set.
  resourcingInternally = false;
  offerResume();

  // A file the browser cannot decode is the one failure it will not tell us about
  // in advance. `canPlayType` is useless here, it answers about the CONTAINER, not
  // the codecs inside, and returns empty even for files Chrome then plays. So the
  // only honest detection is the error event, after trying. This is also the limit
  // of MKV support: the CONTAINER is readable by us, but whether its video DECODES
  // is the browser's business, and for HEVC it often will not.
  els.video.addEventListener(
    'error',
    () => {
      const code = els.video.error?.code;
      setStatus(errorText('VIEWER003', code ? `media error ${code}` : undefined), true);
    },
    { once: true },
  );

  void els.video.play().catch(() => {
    // Autoplay is blocked until the user interacts. Not an error and not worth a
    // message: the controls are right there.
  });

  // A video dropped without a `.mkv` extension is still worth trying, the
  // container, not the filename, decides whether there are tracks in it.
  try {
    await loadEmbeddedTracks(file);
  } catch (error) {
    // CONSOLE ONLY. The viewer is told nothing: an unparseable container is a normal
    // state (there are simply no embedded tracks to offer), not a fault to report.
    logDecoder('embedded-failed', { error: String(error?.message ?? error) });
  }

  // Listed after playback starts, so the control never delays the video. The choice
  // resets per file: a track index means nothing across two different files.
  audioChoice = 0;
  void describeAudio(file);

  // Load a track for the CAPTIONS, without waiting for the worker to ask.
  //
  // The worker asks for a track when the side panel needs the transcript, and on a
  // cache hit it hands the cues back with `SET_TRACK` rather than fetching, so the
  // usual flow does give us cues. But the viewer must also work with NO panel at
  // all, and then nothing ever asks, and the captions stayed blank while the film
  // played. So the default track is loaded here, and `SET_TRACK` later replaces it
  // with whatever the worker chose, which is the same list in the ordinary case.
  void loadDefaultTrack();

  render();
}

/**
 * Load the track the viewer would pick, so the captions work with no panel open.
 *
 * The STUDY track first, then the gloss, the preference, or the next readable track
 * that is not the study one. Two lines when the file has two tracks, one when it has
 * one, which is what the panel does beside the video.
 *
 * Deliberately fire-and-forget and deliberately not reported as an error: a file
 * whose cues cannot be read still plays, and the panel, when there is one, will say
 * why in its own status line.
 */
async function loadDefaultTrack() {
  // The learner's own choices win; otherwise the viewer picks. This is the same
  // preference the panel reads, so a track chosen in the panel's dropdown is the one
  // the captions draw.
  //
  // **A stored language that now resolves to an UNREADABLE track is not honoured.**
  // `studyLanguage` is a language code, not a track identity, and codes are not unique
  // across files: a learner who studied `ja` on one film, then opens a film whose only
  // `ja` track is a Blu-ray PGS image track, had the image track selected, `ensureSegments`
  // returned nothing for a non-text track, and the captions were permanently blank with
  // no way to get them back except changing the language. Measured exactly that on a disc
  // remux: pick chose `ja n=25 kind=image`, read-skipped it, and drew zero cues forever.
  // So an unreadable named track falls through to the readable default instead, which the
  // viewer then shows in its picker.
  const named = trackFor(settings.studyLanguage);
  const study = named && named.kind === 'text' ? named : pickDefaultTrack();
  if (named && named.kind !== 'text') {
    logSubs('pick-unreadable', {
      stored: settings.studyLanguage,
      kind: named.kind,
      fallback: study ? `${study.languageCode} n=${study.trackNumber}` : 'NONE',
    });
  }
  logSubs('pick', {
    studyLanguage: settings.studyLanguage ?? 'null',
    chosen: study ? `${study.languageCode} n=${study.trackNumber} kind=${study.kind}${study.error ? ' ERR:' + study.error : ''}` : 'NONE',
    available: tracks.map((t) => `${t.languageCode}/${t.source}/${t.kind}`).join(','),
  });
  if (!study) {
    logSubs('pick-none', { reason: 'no track to load, captions will stay empty' });
    return;
  }
  try {
    logSubs('read-start', { track: study.languageCode, kind: study.kind, cached: Boolean(study.segments) });
    segments = await ensureSegments(study);
    activeTrackLanguage = study.languageCode;
    lastIndex = -2;
    lastRendered = -2;
    logSubs('read-done', { track: study.languageCode, count: segments.length, error: study.error ?? 'none' });
    // The list follows the track, so the dictionary is loaded for THIS language
    // before anything is marked. Fire-and-forget: the captions are on screen already
    // and gain their marks when the dictionary lands.
    void prepareMarks(study.languageCode);
    redrawCaptions();
    // **Repaint the pickers so the study dropdown shows the track just chosen.** When
    // `settings.studyLanguage` is null the viewer picks the track itself, and the picker
    // was last drawn before that choice existed, so without this it shows the first track
    // while the captions draw the picked one. See `renderTrackChoosers`.
    renderTrackPickers();
    logSubs('drawn', { count: segments.length, t: Number(els.video.currentTime.toFixed(2)) });
    // The gloss, if there is a second track. Awaited only to align it; the captions
    // are already on screen without it.
    void loadGlossTrack(study);
  } catch (error) {
    // A track that cannot be read is normal for an image-based subtitle, and the
    // panel reports it. Nothing to say here beyond the trace.
    logSubs('read-failed', { track: study.languageCode, error: String(error?.message ?? error) });
  }
}



/**
 * Load the second subtitle track, if the learner asked for one.
 *
 * **The viewer can show two lines because a local file can carry two tracks**, Chinese
 * traditional and English in the same MKV, for instance. That is the same arrangement the
 * panel has, drawn over the video instead of beside it, so the alignment comes from the
 * shared `alignSecondary` rather than a second implementation with its own drift
 * tolerance.
 *
 * **A second line is OPT-IN, and it is drawn only from the chosen track.** This used to
 * fall back to "the first readable track that is not the study one" whenever the gloss
 * setting was empty, which meant a file with two tracks drew a second line the learner
 * never asked for, while the panel's own picker (and the viewer's) correctly said "Off".
 * Two controls disagreed about what was on screen. Off means off: a second line appears
 * only when `glossLanguage` names a track.
 *
 * @param {object} study
 */
async function loadGlossTrack(study) {
  const chosen = trackFor(settings.glossLanguage);
  logSubs('gloss-pick', {
    glossLanguage: settings.glossLanguage ?? 'null',
    chosen: chosen ? `${chosen.languageCode} n=${chosen.trackNumber}${chosen.error ? ' ERR:' + chosen.error : ''}` : 'NONE',
    study: study?.languageCode ?? 'none',
  });
  // Never the same track twice: a "gloss" identical to the line above it is noise, not a
  // translation. And no fallback: an unset gloss is "Off", not "pick one for me".
  if (!chosen || chosen === study) {
    glossLines = [];
    redrawCaptions();
    return;
  }
  try {
    const cues = await ensureSegments(chosen);
    // Aligned by start time with a drift tolerance, so an out-of-sync second track leaves
    // the line blank rather than pairing it with the wrong cue.
    glossLines = alignSecondary(segments, cues);
    logSubs('gloss-aligned', {
      track: chosen.languageCode,
      studyCues: segments.length,
      glossCues: cues.length,
      filled: glossLines.filter(Boolean).length,
      firstStart: cues[0]?.start != null ? Number(cues[0].start.toFixed(2)) : 'nil',
    });
    redrawCaptions();
  } catch (error) {
    logSubs('gloss-failed', { error: String(error?.message ?? error) });
    glossLines = [];
    redrawCaptions();
  }
}

/** @param {File[]} files */
async function loadSubtitles(files) {
  for (const file of files) {
    // Read as bytes, not text, so `subtitles.js` can detect the encoding rather than
    // compounding a guess about it with a default.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseSubtitles(bytes, file.name);
    const { segments: cues, format, encoding, error } = parsed;

    const languageCode = languageFromFileName(file.name);
    logSubtitle(file, { ...parsed, size: file.size }, languageCode);

    // Replace a track for the same language rather than listing both, so picking a
    // corrected version of the same file does not leave the old one behind.
    tracks = tracks.filter((track) => !(track.source === 'file' && track.languageCode === languageCode));
    tracks.push({ languageCode, name: file.name, source: 'file', segments: cues, error, format, encoding });
  }

  const usable = tracks.filter((track) => track.segments?.length);
  if (!usable.length) {
    const first = tracks[0];
    setStatus(errorText('VIEWER002', first?.error ?? 'no subtitle cues'), true);
  } else if (usable.length === 1) {
    setStatus(`${usable[0].segments.length} cues · ${usable[0].format} · ${usable[0].encoding}`);
  } else {
    setStatus(`${usable.length} subtitle tracks`);
  }

  // The Line 1 / Line 2 pickers list `tracks`, so they are stale the moment this
  // function changes that list. `loadEmbeddedTracks` re-renders because it ends in
  // `renderTrackPickers`, but a SIDECAR-only selection never reaches it: an MP4 with
  // `.srt` files beside it has no embedded tracks to discover, so the pickers stayed
  // disabled and empty while the status line said "3 subtitle tracks". Rendering here
  // is what makes two sidecar languages, one for each line, choosable at all.
  renderTrackChoosers();

  // And the captions must follow the same list, for the same reason.
  //
  // `loadVideo` ends by loading a default track, but it runs BEFORE this function
  // and a sidecar selection has no tracks yet at that point, so its attempt found
  // nothing and returned. The captions then stayed blank while the film played and
  // the track pickers listed three usable files, leaving the transcript empty
  // until the user touched a control. Re-run it now that `tracks` is populated.
  void loadDefaultTrack();
}

/**
 * Find the subtitle tracks inside a video file.
 *
 * Cheap: this reads only the `Tracks` element, which precedes the media, so a film's
 * subtitle list arrives without its clusters being touched. That is what lets the
 * panel offer "Japanese / English / Chinese" the moment a file is opened rather than
 * after reading two gigabytes.
 *
 * @param {File} file
 */
async function loadEmbeddedTracks(file) {
  const found = await readMatroskaTracks(viewerFor(file));
  logEmbeddedTracks(found);
  logSubs('embedded-found', { count: found.length, kinds: found.map((t) => `${t.number}:${t.kind}`).join(',') });
  // Anything we already have from a sidecar wins, because the user chose it
  // explicitly and a file's own track is not more authoritative than that.
  const fromFiles = tracks.filter((track) => track.source === 'file');
  const usedCodes = new Set(fromFiles.map((track) => track.languageCode));
  const embedded = [];

  for (const track of found) {
    const code = track.language ?? 'und';
    // A duplicate language is offered as `ja (2)` rather than dropped: a film with
    // two Japanese tracks (one full, one signs-only) is a real shape.
    let unique = code;
    for (let n = 2; usedCodes.has(unique) || embedded.some((t) => t.languageCode === unique); n++) {
      unique = `${code} (${n})`;
    }
    usedCodes.add(unique);

    embedded.push({
      languageCode: unique,
      name: track.name ?? null,
      source: 'embedded',
      trackNumber: track.number,
      codec: track.codec,
      kind: track.kind,
      segments: null,
      error:
        track.kind === 'text'
          ? null
          : track.kind === 'image'
            ? errorText('VIEWER004', imageCodecName(track.codec) ?? track.codec)
            : `unsupported subtitle format (${track.codec})`,
      format: track.codec,
      encoding: 'utf-8',
    });
  }

  tracks = [...fromFiles, ...embedded];

  if (!tracks.length) {
    setStatus(errorText('VIEWER005'), true);
    return;
  }

  setStatus(`${tracks.length} subtitle track${tracks.length === 1 ? '' : 's'} in this video`);
  // The track pickers are populated only once the tracks are KNOWN, which is after
  // the container has been read. Rendering them earlier left them empty, a picker
  // offering nothing to choose while the status line says there are three tracks is
  // the confusing half of the two being out of step.
  renderTrackPickers();
}

/**
 * Read the caption cues, in a BOUNDED first pass and then a background fill.
 *
 * ## Why two passes
 *
 * In Matroska a caption track's blocks live inside the video's clusters, so reading them
 * used to mean walking the whole file: measured, one track on a 25 GB film cost 3278 reads
 * of 8 MiB, 27.5 GB, and the browser took 79 SECONDS to reach the first caption. The viewer
 * sat on a working film with no subtitles and no explanation for that long.
 *
 * The container has an answer: `SeekHead` names the byte offset of `Cues`, which maps
 * timestamps to cluster positions, so the clusters for a window of time can be read
 * directly. Measured on the same film, a 60-second window cost 39 reads and 0.85 seconds
 * instead of 9055.
 *
 * So the first pass reads only the window the viewer is about to need and captions appear
 * almost at once. The second pass then reads the REST in the background, so a later seek
 * into a region that was not in the first window is served from a list that is already
 * filling rather than starting the scan from nothing.
 *
 * ## The first window is chosen to be useful, not to be small
 *
 * It starts a little before the current position (or zero on a fresh open, where playback
 * begins at zero) and runs well past it, so ordinary playback for the next few minutes
 * never waits on the second pass. It is a few minutes rather than the whole film, which is
 * what keeps the first pass bounded.
 *
 * ## And when the file has no index
 *
 * A file with no `Cues` cannot be windowed, and `readMatroska` reports that by returning
 * `windowed: false`. Then the first pass IS the whole file, which is the old behaviour, and
 * there is no second pass to run. Slow, but correct, and it is the only option a file with
 * no index leaves.
 */

/** How far before the playhead the first caption window starts, in seconds. */
const CAPTION_WINDOW_BACK = 5;

/**
 * How far past the playhead the first caption window runs, in seconds.
 *
 * A few minutes, not a few seconds: the first pass is what the viewer waits on, and the
 * second pass should have to catch up only after several minutes of ordinary playback
 * rather than seconds of it.
 */
const CAPTION_WINDOW_AHEAD = 300;

/** The cue list per track, keyed by track number, merged from both passes. */
let cuesByNumber = new Map();
/** Whether the first (bounded) pass applied an index window, so a second pass is owed. */
let cuesWindowed = false;
/** The promise for the first pass, shared so a track is never read twice at once. */
let firstPassPromise = null;
/** The promise for the background remainder, or null when there is none to run. */
let fillPassPromise = null;

/**
 * The window the first caption pass should read, in source seconds.
 *
 * @returns {{from: number, to: number}}
 */
function captionWindow() {
  const now = Number.isFinite(els.video.currentTime) ? els.video.currentTime : 0;
  return {
    from: Math.max(0, now - CAPTION_WINDOW_BACK),
    to: now + CAPTION_WINDOW_AHEAD,
  };
}

/**
 * The first caption pass: the window around the playhead, using the file's index.
 *
 * @returns {Promise<void>}
 */
function readCuesFirstPass() {
  if (firstPassPromise) return firstPassPromise;
  const numbers = tracks.filter((track) => track.kind === 'text').map((track) => track.trackNumber);
  const win = captionWindow();
  const startedAt = Date.now();
  logSubs('cues-first-start', { tracks: numbers.join(','), from: win.from.toFixed(0), to: win.to.toFixed(0) });
  firstPassPromise = readMatroska({ ...viewerFor(videoFile), trackNumbers: numbers, window: win })
    .then(({ cues, truncated, windowed }) => {
      cuesByNumber = cues;
      cuesWindowed = windowed;
      logSubs('cues-first-done', {
        ms: Date.now() - startedAt,
        windowed,
        truncated,
        counts: numbers.map((n) => `${n}:${(cues.get(n) ?? []).length}`).join(','),
      });
    })
    .catch((error) => {
      firstPassPromise = null;
      logSubs('cues-first-failed', { error: String(error?.message ?? error) });
      throw error;
    });
  return firstPassPromise;
}

/**
 * The second caption pass: the whole file, in the background, replacing the window.
 *
 * Runs only when the first pass was actually windowed, so a file with no index is not read
 * twice. It never rejects to the caller: a failed fill leaves the first pass's cues in
 * place, which is a working viewer with less coverage rather than a broken one.
 *
 * @returns {Promise<void>}
 */
function readCuesFillPass() {
  if (fillPassPromise || !cuesWindowed) return fillPassPromise ?? Promise.resolve();
  const numbers = tracks.filter((track) => track.kind === 'text').map((track) => track.trackNumber);
  const startedAt = Date.now();
  logSubs('cues-fill-start', { tracks: numbers.join(',') });
  fillPassPromise = readMatroska({ ...viewerFor(videoFile), trackNumbers: numbers })
    .then(({ cues, truncated }) => {
      // The full read is authoritative and REPLACES the window rather than merging cue by
      // cue: a windowed read and a full read of the same track can differ at the edges, and
      // the full one is the truth.
      cuesByNumber = cues;
      logSubs('cues-fill-done', {
        ms: Date.now() - startedAt,
        truncated,
        counts: numbers.map((n) => `${n}:${(cues.get(n) ?? []).length}`).join(','),
      });
      // Re-point every track at the fuller list, then redraw for the current position. A
      // seek made while the fill was running is covered by this: the redraw uses wherever
      // the playhead is NOW, not where it was when the first pass ran.
      for (const track of tracks) {
        if (track.kind !== 'text') continue;
        track.segments = cuesByNumber.get(track.trackNumber) ?? track.segments;
        if (track.segments?.length) track.error = null;
      }
      if (activeTrackLanguage) segments = trackFor(activeTrackLanguage)?.segments ?? segments;
      redrawCaptions();
    })
    .catch((error) => {
      logSubs('cues-fill-failed', { error: String(error?.message ?? error) });
    });
  return fillPassPromise;
}

/**
 * The cues for one track, from the first (bounded) pass, filling in the background.
 *
 * @param {object} track
 * @returns {Promise<Array<object>>}
 */
async function ensureSegments(track) {
  if (track.segments) {
    logSubs('read-cached', { track: track.languageCode, count: track.segments.length });
    return track.segments;
  }
  if (track.kind !== 'text') {
    logSubs('read-skipped', { track: track.languageCode, kind: track.kind, reason: 'not a text track' });
    return [];
  }

  logSubs('read-await', { track: track.languageCode, n: track.trackNumber });
  await readCuesFirstPass();

  track.segments = cuesByNumber.get(track.trackNumber) ?? [];
  if (!track.segments.length) {
    // **"no cues in the first window" is NOT "no cues at all".** The first pass reads a
    // few minutes, so a track whose dialogue begins later has an empty window and is
    // perfectly healthy. Reporting an error there was the old single-pass assumption, where
    // an empty result really did mean the track was empty. So an empty window is left alone
    // here; the fill pass replaces it with the full list, and only THEN can emptiness be
    // called an error.
    logSubs('read-empty-window', { track: track.languageCode });
  }
  // The first pass is bounded and the rest of the file still has to be read. Started once
  // and shared, so opening several tracks does not start several fills.
  void readCuesFillPass();
  logSubs('read-done', { track: track.languageCode, count: track.segments.length, error: track.error ?? 'none' });
  return track.segments;
}

/** Mirror the chosen files into the bar, so the page says what it is holding. */
function render() {
  const names = [videoFile?.name, ...tracks.map((track) => track.name)].filter(Boolean);
  els.chosen.textContent = names.length ? names.join(' · ') : 'No files chosen';
  els.chosen.title = els.chosen.textContent;
  document.title = titleFor(videoFile?.name);
}

/**
 * The page title: our name, then the file, cut to fit.
 *
 * The tab is how someone tells one viewer window from another when several films
 * are open, so the file name belongs in it. It is cut rather than allowed to run
 * on, because a tab strip shows roughly this many characters before it elides
 * anyway, and losing our own name entirely is worse than shortening theirs.
 *
 * @param {string | undefined} name
 */
const TITLE_NAME_MAX = 40;
function titleFor(name) {
  if (!name) return 'IU';
  const short = name.length > TITLE_NAME_MAX ? `${name.slice(0, TITLE_NAME_MAX - 1)}…` : name;
  return `IU · ${short}`;
}

// --- Captions ----------------------------------------------------------------

/** The cue playing now, or -1 between cues. */
function activeIndex() {
  if (!segments.length) return -1;
  return findActiveIndex(segments, els.video.currentTime);
}

/**
 * How long a finished cue stays on screen.
 *
 * A subtitle whose cue has ENDED is not the current line, and leaving it up made a long
 * silent stretch show the last thing said, wrong for a film in a way it is not wrong
 * for a side panel, where the row stays highlighted so it can be found again.
 *
 * The value is a SETTING (`captionFade`, in seconds) rather than the constant this
 * once was, because how long to hold is a reading-speed preference and not something
 * to guess for everyone. 0 disables the fade and keeps the old behaviour.
 *
 * The hold also has to cover consecutive cues with a fraction of a second between
 * them, so an ordinary dialogue run does not blink. That is now the viewer's job to
 * get right rather than the constant's: `captionClearDelayMs` returns 0 while the
 * next cue is imminent, which cancels the clear instead of racing it.
 */

/**
 * The delay, in ms, before a finished cue should be cleared.
 *
 * A thin adapter over `captionHoldSeconds`, which holds the decision and is tested
 * hermetically.
 *
 * **Scaled by `playbackRate`, because the timer is wall-clock and the hold is content.**
 * `captionFade` is a reading-time preference measured in the film's own seconds, so at 2x
 * a 0.5s hold must last 0.25 real seconds or the line lingers over content it no longer
 * belongs to. A rate-scaled timer is the one place a second-of-content becomes a
 * second-of-wall-clock, and doing it here keeps every other caption rule rate-free.
 *
 * @param {number} seconds The playhead, in seconds.
 * @returns {number}
 */
function captionClearDelayMs(seconds) {
  const rate = Math.min(8, Math.max(0.125, els.video.playbackRate || 1));
  return (captionHoldSeconds(segments, seconds, settings.captionFade) * 1000) / rate;
}

/** Pending clears, keyed by the primary element they would empty. */
const captionTimers = new Map();

/**
 * How long the dissolve itself takes, in ms.
 *
 * Separate from the hold, which is the user's `captionFade` setting. This is the
 * animation, and it is fixed: the two are added, so the line is fully gone
 * `captionFade` seconds plus this after the cue ended. Kept in sync with the
 * `.caption-fading` transition in `viewer.css` by hand, since a stylesheet cannot
 * import a number from a script here.
 */
const CAPTION_FADE_OUT_MS = 300;

/** @param {HTMLElement} primary */
function cancelClear(primary) {
  const pending = captionTimers.get(primary);
  if (pending) {
    clearTimeout(pending);
    captionTimers.delete(primary);
  }
  // A new cue arriving while the previous one was mid-dissolve has to become opaque
  // again, or the replacement text renders into a card that is still fading out and
  // appears at whatever opacity the transition had reached.
  fadeTarget(primary).classList.remove('caption-fading');
}

/**
 * The caption containers that fade as one, given a line element.
 *
 * The overlay's card holds both lines, so opacity goes on the CARD or the two lines
 * dissolve at different rates and the box stays behind them. The below strip has no
 * card, so the strip itself is the fading element.
 *
 * @param {HTMLElement} primary
 * @returns {HTMLElement}
 */
function fadeTarget(primary) {
  return primary.closest('.caption-card') ?? primary.closest('.captions') ?? primary;
}

/**
 * Fade a placement's caption out after `delayMs`, then empty it.
 *
 * Keyed by the primary element so a later cue cancels the fade a previous one
 * scheduled, without that, a line would vanish shortly after it appeared.
 *
 * @param {HTMLElement} primary
 * @param {HTMLElement} secondary
 * @param {number} delayMs
 */
function scheduleClear(primary, secondary, delayMs) {
  cancelClear(primary);
  const target = fadeTarget(primary);
  captionTimers.set(
    primary,
    setTimeout(() => {
      // The hold elapsed. Start the dissolve, and empty the elements only once it has
      // finished, so the text is still there to be seen as it goes rather than
      // disappearing and leaving a box that fades by itself.
      target.classList.add('caption-fading');
      captionTimers.set(
        primary,
        setTimeout(() => {
          captionTimers.delete(primary);
          target.classList.remove('caption-fading');
          primary.replaceChildren();
          secondary.replaceChildren();
        }, CAPTION_FADE_OUT_MS),
      );
    }, delayMs),
  );
}

/**
 * Draw the current cue into BOTH placements.
 *
 * Both are written together so switching placement never shows a stale line, a
 * switch that revealed the last cue from ten minutes ago would look like a bug in
 * the video. Only one is visible at a time; the other is `hidden`.
 *
 * The tokens are rendered by `renderReading` from `common/marks.js`, the SAME
 * function the panel uses, so a word looks the same here as in the transcript and
 * the caption text cannot drift from it. Duplicating the rendering would have been
 * the obvious shortcut and is exactly the drift this shares instead.
 *
 * @param {number} index
 */
function renderCaptions(index) {
  const cue = index >= 0 ? segments[index] : null;
  const levelCount = listLevelCount();

  // `findActiveIndex` answers "which cue started most recently", the right question
  // for a transcript and the wrong one for a subtitle. A cue that STARTED is not a cue
  // that is still PLAYING, and without this check the last line of a scene stayed on
  // screen through every silent stretch that followed it, indefinitely.
  const stillPlaying = Boolean(cue) && els.video.currentTime < cue.start + cue.duration;

  logSubs('render', {
    index,
    cues: segments.length,
    t: Number(els.video.currentTime.toFixed(2)),
    cueStart: cue ? Number(cue.start.toFixed(2)) : 'nil',
    stillPlaying,
  });

  if (!stillPlaying) {
    // A cue that has ENDED. This is the case the previous version got wrong: it
    // only scheduled the clear when it was called, and `onTimeUpdate` only called it
    // when the cue INDEX changed. A cue ending into a long gap does not change the
    // index, so the clear was never scheduled and the line sat through the whole
    // silence until the next cue started. The delay now comes from the setting, and
    // it is 0 (no clear) while the next cue is imminent.
    const delay = captionClearDelayMs(els.video.currentTime);
    if (delay > 0) {
      scheduleClear(els.overlayPrimary, els.overlaySecondary, delay);
      scheduleClear(els.belowPrimary, els.belowSecondary, delay);
    }
    return;
  }

  // A cue IS playing, so any pending clear is called off, otherwise the line would
  // disappear a second after it appeared.
  cancelClear(els.overlayPrimary);
  cancelClear(els.belowPrimary);

  for (const element of [els.overlayPrimary, els.belowPrimary]) {
    element.replaceChildren();
    if (cue.marked) element.append(renderReading(cue.marked, levelCount));
    // No marks yet: the plain text, which is a perfectly good subtitle. The
    // annotations arrive when the dictionary does.
    else element.append(document.createTextNode(cue.text ?? ''));
  }

  // The gloss line: the second subtitle track's text for this cue, when the learner
  // has chosen one. Emptied when there is none, and the CSS collapses it rather than
  // leaving a blank card beside the caption.
  const gloss = index >= 0 ? (glossLines[index] ?? '') : '';
  for (const element of [els.overlaySecondary, els.belowSecondary]) {
    element.replaceChildren();
    if (gloss) element.append(document.createTextNode(gloss));
  }
}

/**
 * The definition for a hovered caption word, from the dictionary in hand.
 *
 * Built here rather than asked of the worker: the viewer holds the whole dictionary
 * already, and a message per hover would be a round trip for data this page can read
 * directly. The SHAPE is the one `showEntry` expects, so the popover code does not
 * know which surface it is drawing for, the panel supplies the same shape from a
 * worker reply.
 *
 * @param {string} word
 */
function definitionFor(word) {
  if (!dictionary) return;
  const entry = lookup(dictionary, word);
  const list = listIndex?.lists?.find((candidate) => candidate.id === listId) ?? null;
  const level = list ? levelOf(dictionary, list.id, word) : null;
  showEntry({
    word,
    entry,
    // One badge, for the single list a viewer grades against. The panel shows every
    // list's opinion because the learner is choosing between them; the viewer has
    // already chosen.
    levels:
      level === null || !list
        ? null
        : [
            {
              id: list.id,
              label: list.label,
              level,
              levelCount: list.levelCount,
              levelName: list.levelNames?.[level - 1],
            },
          ],
  });
}

/** How many levels the list in use declares, for the colour ramp. */
function listLevelCount() {
  const list = listIndex?.lists?.find((entry) => entry.id === listId);
  return list?.levelCount ?? 1;
}

/**
 * Fill the two subtitle-track pickers.
 *
 * The same choices the panel's dropdowns offer, from the same `tracks` list, so the
 * two surfaces cannot disagree about what a file contains, and so a track chosen in
 * one is honoured by the other, since both write the same setting.
 *
 * "Off" on the second line is a real preference, not the absence of one: one line is
 * the ordinary way to watch, and two lines is the study mode.
 */
function renderTrackChoosers() {
  const studySelect = document.getElementById('study-track');
  const glossSelect = document.getElementById('gloss-track');
  if (!studySelect || !glossSelect) return;

  // **The study picker shows the track actually being drawn, not the raw setting.**
  // `settings.studyLanguage` is null until the learner chooses, and the viewer has still
  // picked a track itself (`pickDefaultTrack`, which prefers a markable language). Driving
  // the select from the null setting marked NO option selected, so the browser showed the
  // FIRST option while the captions drew the picked one: on a file whose picked track is
  // Japanese, the picker said English. So the displayed value is the active track when the
  // setting is unset, which is what a "Match the track"-style automatic choice means
  // everywhere else in this file.
  const shownStudy = settings.studyLanguage ?? activeTrackLanguage ?? '';
  const signature =
    tracks.map((track) => `${track.languageCode}:${track.name ?? ''}`).join(',') +
    `|${shownStudy}|${settings.glossLanguage ?? ''}`;
  if (studySelect.dataset.signature === signature) return;
  studySelect.dataset.signature = signature;
  glossSelect.dataset.signature = signature;

  for (const [select, chosen, includeOff] of [
    [studySelect, shownStudy, false],
    [glossSelect, settings.glossLanguage, true],
  ]) {
    select.replaceChildren();
    select.disabled = tracks.length === 0;
    if (!tracks.length) {
      select.append(new Option('-', ''));
      continue;
    }
    if (includeOff) {
      const off = new Option('Off', '');
      off.selected = !chosen;
      select.append(off);
    }
    for (const track of tracks) {
      const label = track.name || track.languageCode;
      const option = new Option(label, track.languageCode);
      option.selected = track.languageCode === chosen;
      select.append(option);
    }
  }
}

/**
 * Fill the word-list and threshold pickers in the caption row.
 *
 * Rebuilt only when their contents would differ, so a state change does not reset
 * the control the user is using, the same guard the panel's selects carry.
 *
 * The list options come from the loaded index and the threshold options from the
 * chosen list, so the two cannot offer a level the list does not have.
 */
function renderTrackPickers() {
  const listSelect = document.getElementById('word-list');
  const thresholdSelect = document.getElementById('threshold');
  if (!listSelect || !thresholdSelect) return;

  const lists = listIndex?.lists ?? [];
  const listSignature = lists.map((entry) => entry.id).join(',') + `|${settings.listId ?? ''}`;
  if (listSelect.dataset.signature !== listSignature) {
    listSelect.dataset.signature = listSignature;
    listSelect.replaceChildren();
    if (!lists.length) {
      listSelect.append(new Option('-', ''));
      listSelect.disabled = true;
    } else {
      listSelect.disabled = false;
      // "Match the track" is a real option, not the absence of one: a learner who
      // has not chosen should see that the viewer is choosing for them, rather than
      // a picker that looks unset.
      const auto = new Option('Match the track', '');
      auto.selected = !settings.listId;
      listSelect.append(auto);
      for (const list of lists) {
        const option = new Option(list.label, list.id);
        option.selected = list.id === settings.listId;
        listSelect.append(option);
      }
    }
  }

  renderTrackChoosers();

  const list = resolvedList();
  const levels = list ? Array.from({ length: list.levelCount }, (_, i) => i + 1) : [];
  const thresholdSignature = `${list?.id ?? ''}|${settings.threshold ?? ''}`;
  if (thresholdSelect.dataset.signature !== thresholdSignature) {
    thresholdSelect.dataset.signature = thresholdSignature;
    thresholdSelect.replaceChildren();
    if (!levels.length) {
      thresholdSelect.append(new Option('-', ''));
      thresholdSelect.disabled = true;
    } else {
      thresholdSelect.disabled = false;
      for (const level of levels) {
        // The list's OWN name for the level, never the stored number: JLPT counts
        // N5..N1, so printing the stored 1 as "1" reads as the hardest level on the
        // easiest word. Same rule the panel's badge follows.
        const option = new Option(list.levelNames?.[level - 1] ?? String(level), String(level));
        option.selected = level === (settings.threshold ?? 1);
        thresholdSelect.append(option);
      }
    }
  }
}

/**
 * The list the viewer grades against.
 *
 * An explicit choice wins; otherwise the list is matched to the track's language, and
 * the BROADEST one for it, a viewer with no other information should mark as much as
 * it honestly can. Resolved through the shared `listForLanguage` so the panel and the
 * viewer cannot disagree about which list covers a language.
 */
function resolvedList() {
  const lists = listIndex?.lists ?? [];
  if (settings.listId) {
    return lists.find((list) => list.id === settings.listId) ?? null;
  }
  return listForLanguage(lists, trackLanguage());
}

/** Show or hide the caption strip, in the placement the settings name. */
function applySettings() {
  const on = settings.captionsOn;
  const below = settings.captionPlacement === 'below';

  els.overlay.hidden = !on || below;
  els.below.hidden = !on || !below;
  els.captionRow.hidden = !on;

  const button = document.getElementById('captions');
  button.setAttribute('aria-pressed', String(on));
  const label = on ? 'Hide captions' : 'Show captions';
  button.setAttribute('aria-label', label);
  button.title = label;

  for (const chip of document.querySelectorAll('[data-placement]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.placement === settings.captionPlacement));
  }

  document.getElementById('reading').value = settings.romaji;
  document.getElementById('marks').value = settings.markStyle;
  document.getElementById('speed').value = settings.defaultSpeed;
  document.getElementById('caption-size').value = String(settings.captionSize);
  // The one thing the size control has to do: it sets the custom property the
  // caption rules read. It was dead markup before, present, styled, and wired to
  // nothing, so moving it changed nothing.
  document.documentElement.style.setProperty('--caption-size', `${settings.captionSize}px`);
  renderTrackPickers();
  document.documentElement.classList.toggle('mark-highlight', settings.markStyle === 'highlight');
  document.documentElement.classList.toggle('mark-underline', settings.markStyle !== 'highlight');
  if (els.video.playbackRate !== Number(settings.defaultSpeed)) {
    els.video.playbackRate = Number(settings.defaultSpeed);
  }
  applyDifficulty();

  // Pushed into the renderer, which reads the placement from the last settings it
  // was given rather than taking it as an argument, the same arrangement the panel
  // uses, so the reading is drawn identically on both surfaces.
  // Passed field by field rather than wholesale because the viewer's `settings` is
  // its own storage shape, not the worker's `learning` payload. `language` is the
  // track's, which is what the viewer is actually showing.
  setReadingSettings({
    romaji: settings.romaji,
    chineseScript: settings.chineseScript,
    language: trackLanguage(),
    japaneseScript: settings.japaneseScript,
    koreanScript: settings.koreanScript,
  });

  measureBar();
}

/** The bar's own height, so the overlay captions can sit clear of it. */
function measureBar() {
  const height = els.bar.getBoundingClientRect().height;
  if (height > 0) {
    document.documentElement.style.setProperty('--bar-offset', `${Math.round(height)}px`);
  }
}

// --- The bar's lifecycle -----------------------------------------------------
//
// ONE mechanism: the bar is visible or it is not, and it becomes not-visible when
// the pointer has been idle.

let idleTimer = null;
let focused = false;

function showBar() {
  els.bar.dataset.hidden = 'false';
}

/**
 * Hide the bar after a period without movement.
 *
 * Two things stop it, and each is a case where hiding would be wrong:
 *   - `focused`, because a keyboard user must never have an invisible control
 *     receive their focus. This is the trap pointer-only hiding walks into.
 *   - `paused`, because pausing is what people do right before reaching for a
 *     control.
 */
function scheduleHide() {
  clearTimeout(idleTimer);
  if (focused || els.video.paused) return;
  idleTimer = setTimeout(() => {
    // Re-checked at fire time: the video may have paused or focus may have arrived
    // since the timer was set.
    if (!focused && !els.video.paused) els.bar.dataset.hidden = 'true';
  }, 2500);
}

els.stage.addEventListener('mousemove', () => {
  showBar();
  scheduleHide();
});

els.stage.addEventListener('mouseleave', scheduleHide);

// Keyboard users get the bar back, permanently, for as long as focus is inside it.
els.bar.addEventListener('focusin', () => {
  focused = true;
  showBar();
});

els.bar.addEventListener('focusout', (event) => {
  // `focusout` fires when moving BETWEEN children too, so the test is whether focus
  // left the bar entirely, `relatedTarget` is where it went.
  if (els.bar.contains(event.relatedTarget)) return;
  focused = false;
  scheduleHide();
});

// --- The time bar ------------------------------------------------------------
//
// A scrubber, a counter and a difficulty band. The band is the part a generic player
// cannot have: it draws where the marked words are, so the hard stretch of a file is
// visible on the timeline before you reach it.
//
// Moved here from the preview, where it was designed. The BAND is the one thing that
// needed reworking: the preview read a synthetic `level` off each cue, while the viewer
// marks real tokens, so the level comes off `cue.marked`, which `markSegments` fills
// with the same `markLine` the panel uses. Nothing new is computed; the same marks that
// underline the words decide the colour of the band.
//
// `timecode` already existed further down, for the resume banner. Reused rather than
// redefined: the band and the counter must format a timestamp the same way.

/**
 * Paint the counter, the scrubber position and the played region.
 *
 * Driven from the same tick as the captions rather than from `timeupdate`, so the
 * three never disagree about where playback is, they are one reading of the clock.
 */
function paintTime() {
  const duration = els.video.duration;
  const now = els.video.currentTime;
  els.timeCurrent.textContent = timecode(now);
  els.timeDuration.textContent = Number.isFinite(duration) ? timecode(duration) : '-';

  if (!Number.isFinite(duration) || duration <= 0) return;
  // The range's MAX is the duration, set once known. A range on a fixed 0-100 scale
  // would make the thumb's position a percentage to convert every frame, and would
  // quantise every seek to 1% of the film. Setting it also repaints the band, which
  // could not compute percentages before there was a duration to divide by.
  if (Number(els.scrubber.max) !== duration) {
    els.scrubber.max = String(duration);
    paintDifficulty();
  }
  // Not while the pointer is on the thumb: writing `value` mid-drag fights the drag,
  // which is the classic scrubber bug.
  if (!scrubbing) els.scrubber.value = String(now);
  // The played region, drawn as a gradient stop by the stylesheet.
  els.scrubber.style.setProperty('--played', `${(now / duration) * 100}%`);
}

/**
 * Paint the difficulty band: one span per RUN of cues at the same level.
 *
 * **Runs, not one span per cue.** Adjacent cues of the same level drawn separately
 * leave hairline gaps from rounding, so the band comes out striped rather than
 * continuous, which reads as noise and hides the thing it is meant to show.
 *
 * Coloured with `levelColour`, the same ramp the word underlines use, so a colour
 * means the same thing here as it does on a word in the transcript. That is what makes
 * this more than a heatmap: the band and the marks are one language.
 */
function paintDifficulty() {
  const duration = els.video.duration;
  els.cues.replaceChildren();
  // Before metadata arrives the duration is 0 or NaN, so every percentage would be
  // Infinity and the band would be drawn off the end of the bar. Nothing to paint yet.
  if (!settings.difficulty || !Number.isFinite(duration) || duration <= 0) return;

  /** The level a cue carries, or 0 for none. */
  const levelOfCue = (cue) => {
    const levels = (cue.marked ?? [])
      .map((token) => token.level)
      .filter((level) => typeof level === 'number');
    return levels.length ? Math.max(...levels) : 0;
  };

  // A cue carries `start` and `duration`, NOT `end`, the preview this was ported from
  // used `end`, and reading the wrong field gave `NaN` for every width. CSS rejects
  // `NaN%`, so the assignment was silently dropped and every span rendered 0px wide:
  // a band that existed in the DOM and painted nothing.
  const endOf = (cue) => cue.start + cue.duration;

  const levelCount = listLevelCount();

  // Group consecutive cues at the same level into one span.
  const runs = [];
  for (const cue of segments) {
    const level = levelOfCue(cue);
    if (!level) continue;
    const last = runs.at(-1);
    // A short gap between same-level cues is closed up; a long one is a real break in
    // the difficulty and should show as one.
    if (last && last.level === level && cue.start - last.end < 1.5) {
      last.end = endOf(cue);
      continue;
    }
    runs.push({ level, start: cue.start, end: endOf(cue) });
  }

  for (const run of runs) {
    const mark = document.createElement('span');
    mark.style.left = `${(run.start / duration) * 100}%`;
    mark.style.width = `${Math.max(0.3, ((run.end - run.start) / duration) * 100)}%`;
    // 60% alpha: the band is a hint under the track, and the played region has to stay
    // readable over it.
    mark.style.background = `color-mix(in srgb, ${levelColour(run.level, levelCount)} 60%, transparent)`;
    els.cues.append(mark);
  }
}

/** Whether the scrubber is being dragged, which suppresses the tick's writes to it. */
let scrubbing = false;

/**
 * Reflect the difficulty setting in the button and the band.
 *
 * The label is the ACTION ("Hide difficulty band"), matching the caption toggle, and it
 * carries the band's name, "Hide band" on its own is a mystery in a bar full of things
 * that hide.
 */
function applyDifficulty() {
  const on = settings.difficulty;
  els.difficultyButton.setAttribute('aria-pressed', String(on));
  const label = on ? 'Hide difficulty band' : 'Show difficulty band';
  els.difficultyButton.setAttribute('aria-label', label);
  els.difficultyButton.title = label;
  paintDifficulty();
}

/** @param {boolean} on */
function setDifficulty(on) {
  // Through `setSetting`, so the merge, the write and the re-render are the same path
  // every other control uses. A second write path is how two of them come to disagree.
  void setSetting('difficulty', on);
}

els.difficultyButton.addEventListener('click', () => {
  // The setting lives in the button, so clicking never has to know the prior state.
  setDifficulty(els.difficultyButton.getAttribute('aria-pressed') !== 'true');
});

els.scrubber.addEventListener('pointerdown', () => {
  scrubbing = true;
});
els.scrubber.addEventListener('pointerup', () => {
  scrubbing = false;
});
// `change`, not `input`: `input` fires continuously while dragging, and seeking on every
// frame of a drag would hammer the decoder. The control updates itself visually while
// dragging, so nothing needs the intermediate values.
els.scrubber.addEventListener('change', () => {
  const seconds = Number(els.scrubber.value);
  if (Number.isFinite(seconds)) els.video.currentTime = seconds;
});
// Keyboard seeking has no pointer, so it reports through `input` and `change` together.
els.scrubber.addEventListener('keyup', () => {
  const seconds = Number(els.scrubber.value);
  if (Number.isFinite(seconds)) els.video.currentTime = seconds;
});

// --- Audio tracks ------------------------------------------------------------
//
// Which stream you HEAR, as opposed to which subtitle you read. The two are separate
// controls because they are separate choices: a learner wants the original audio AND
// the subtitle for it, not either one.
//
// ## The two paths, and why both
//
// `HTMLMediaElement.audioTracks` is the right way and is **not available in any
// released browser**, measured 2026-10-09 on Chrome 148 and Firefox 155. It exists in
// Blink behind `--enable-blink-features=AudioVideoTracks` (or the user-facing
// `--enable-experimental-web-platform-features`), where it works correctly, and was
// held back for years because switching froze playback. Fixed in M138.
//
// So: use the API when the browser has it, and fall back to remuxing the file into a
// copy that contains only the chosen track when it does not. `audio-tracks.js` owns
// both and explains the trade; this section owns the UI.
//
// **A third state is real and must be shown**: a file whose audio is AC-3, E-AC-3 or
// DTS. The browser can neither decode those nor play them, so no amount of remuxing
// helps, and the failure mode is SILENCE, no error, nothing to catch. So that case is
// not left to remuxing: the track is transcoded to AAC through the coder packages (ADR
// 0012, ADR 0013), and the selector says what it is doing instead of leaving the viewer
// to work out why the picture had no sound.

/** The file's audio tracks, as last listed. @type {Array<object>} */
let audioTracks = [];
/** The index of the track we want playing. */
let audioChoice = 0;
/** The file backing the current playback, which is what a rebuild would read. */
let audioSourceFile = null;
/**
 * Tears down the live rebuilt stream, if the current playback came from one.
 *
 * Held rather than forgotten because both halves leak otherwise: the `MediaSource`
 * stays attached to an element that has moved on, and the object URL pins the blob it
 * was created from. Called before a new stream replaces it, and when the file is
 * closed, not immediately, because the element is still reading from it.
 *
 * @type {(() => void)|null}
 */
let releaseStream = null;
/** Whether a rebuild is in flight, so the control can say so rather than appear frozen. */
let audioBusy = false;
/**
 * The live transcode stream, present only while a track we must decode is playing.
 *
 * Null in the ordinary case, which is a file the browser plays itself. It is set when
 * the browser cannot decode the chosen track, and torn down on a file change or when a
 * track the browser CAN play is chosen. It is the SAME shape as `releaseStream` (a
 * rebuilt stream), which is the point of this design: the element plays our fragmented
 * MP4 exactly as it plays any other stream, so there is no second clock and none of the
 * synchronisation machinery the earlier Web Audio design needed.
 *
 * @type {{url: string, done: Promise<void>, revoke: () => void}|null}
 */
let transcodeStream = null;
/**
 * The last whole percent of transcode progress that was logged.
 *
 * The conversion reports progress far more often than is useful to print, so the log
 * line is emitted only when the whole percent changes. `-1` so the first `0%` is logged.
 */
let lastTranscodePercent = -1;
/**
 * Whether a decode we attempted has failed.
 *
 * Distinct from `decoderCapability`, which records what the coders CLAIM they can
 * decode. A coder claiming a codec and a decode actually succeeding are different
 * facts, and this is the second one being false. Cleared for each new file, so a
 * failure on one film does not mark the next.
 */
let decoderFailed = false;
/**
 * Whether each codec can be decoded, by the viewer's own codec names.
 *
 * Answered by `canDecodeAudio`, which accounts for the registered coder packages, so
 * it cannot drift from what we actually ship. `null` until probed, and
 * `decoderCanPlay()` fills it.
 *
 * @type {Map<string, boolean>|null}
 */
let decoderCapability = null;
/**
 * Whether the track select is showing.
 *
 * Shown whenever the file actually has more than one, in the transport row. The row is
 * full, so this only appears when it has something to offer, a select over a single
 * option is noise.
 */

/**
 * Whether we can decode a track the browser cannot.
 *
 * Answered by which coder packages are registered, asked through mediabunny's own
 * `canDecodeAudio`, which accounts for registered custom decoders. The names are the
 * viewer's own, from `listAudioTracks`, which are mediabunny's spellings.
 *
 * **This is a name lookup now, not a codec-id lookup, because the coders are the
 * published packages** (`@mediabunny/ac3` handles AC-3 and E-AC-3) rather than a
 * hand-built FFmpeg variant whose contents had to be asked of the binary. The set is
 * therefore "what the packages cover", and the range for anything else is the browser's
 * own `canPlayType`.
 *
 * @param {string} codec The viewer's own codec name for the track.
 * @returns {Promise<boolean>}
 */
async function decoderCanPlay(codec) {
  if (!decoderCapability) decoderCapability = new Map();
  if (decoderCapability.has(codec)) return decoderCapability.get(codec);
  let answer = false;
  try {
    // **Imported lazily, so a file the browser can play never loads the coder bundle.**
    // The bundle carries two WebAssembly codecs and is 690 KB gzipped, and the whole
    // point of the lazy rule is that a file needing none of it pays for none of it.
    const { canDecodeTrack } = await import('./coders.js');
    answer = await canDecodeTrack(codec);
  } catch {
    // The coder is absent or failed to register; either way it cannot decode anything.
    answer = false;
  }
  decoderCapability.set(codec, answer);
  return answer;
}

/**
 * Correct drift between the element's clock and the audio it is decoding for us.
 *
 * **GONE, and its absence is the point of this design.** The decoded audio used to be a
 * second clock that had to be re-sought onto the element's, with a cooldown to stop the
 * corrector looping. Now the element plays our stream itself, so there is nothing to
 * correct; see the module comment in `decode-encode.js`.
 */

/**
 * Build the selector from the file's own track list.
 *
 * Hidden when there is no choice, which is the overwhelmingly common case, a control
 * over a single option is noise, and a one-track file has nothing to select.
 */
function renderAudio() {
  const chosen = audioTracks[audioChoice];
  // The note is empty on purpose: everything diagnostic goes to the console. See
  // `audioNoteFor`.
  const note = audioNoteFor(chosen);

  // **ALWAYS VISIBLE.** It used to appear only when a file had more than one track,
  // on the reasoning that a control over a single option is noise. That was wrong for
  // a reason that matters more than tidiness: the field is the only place that says
  // what audio the viewer is GETTING. Hidden, "one track" and "no track" and "the
  // decoder failed" are all indistinguishable from each other, and a learner with no
  // sound has nowhere to look. The select also states the track itself, so a film
  // with one track now shows that track rather than nothing.
  els.audioField.hidden = false;
  els.audioSelect.hidden = false;

  els.audioSelect.replaceChildren();
  if (!audioTracks.length) {
    // A file with no audio track, or one still being read. Stated plainly rather than
    // left as an empty box, which reads as a rendering bug.
    const option = document.createElement('option');
    option.textContent = 'No audio track';
    option.disabled = true;
    option.selected = true;
    els.audioSelect.append(option);
    els.audioSelect.disabled = true;
    els.audioNote.textContent = note;
    return;
  }

  audioTracks.forEach((track) => {
    const option = document.createElement('option');
    option.value = String(track.index);
    option.textContent = track.label;
    option.selected = track.index === audioChoice;
    els.audioSelect.append(option);
  });

  // The note says only what a viewer could NOT work out by looking, which is ONE case:
  // a codec this browser cannot play AND we cannot decode. The others were all noise,
  // "switching rebuilds a copy of the file" described the implementation rather than
  // the film, "Preparing…" announced a wait already visible in the disabled select, and
  // "we are decoding this for you" announced machinery that is working correctly.
  els.audioNote.textContent = note;
  // The disabled state is the feedback. A control that greys itself for 39 ms reads as
  // responsive; one that also flashes a sentence reads as noisy.
  els.audioSelect.disabled = audioBusy;
}

/**
 * The note beside the audio row.
 *
 * **EMPTY, and everything it used to say now goes to the console instead.** It
 * reported decoder state to the viewer: which codec could not be played, whether we
 * were decoding it, and when a decode failed. A viewer is not a developer and should
 * not be told about codecs or decoders; the audio either plays or it does not.
 *
 * The row itself still always shows the track, so "no track" and "one track" are
 * distinguishable, which was the real problem. Everything diagnostic is traced, so it
 * is still available in a report.
 *
 * @returns {string}
 */
function audioNoteFor() {
  return '';
}

/**
 * List the file's audio tracks and offer the selector if there is a choice.
 *
 * Runs AFTER playback starts and never blocks it: listing reads the container, and a
 * viewer should not wait on a control they may not use.
 *
 * @param {File} file
 */
async function describeAudio(file) {
  audioSourceFile = file;
  audioTracks = [];
  audioChoice = 0;
  // Cleared per file: a failure to decode one film says nothing about the next.
  decoderFailed = false;
  // The row stays visible through the read, so the viewer can always see that the
  // audio row exists rather than watching it appear.
  audioTracks = [];
  renderAudio();
  try {
    const declared = await listAudioTracks(file);
    // The file may have been replaced while this was reading.
    if (file !== audioSourceFile) return;
    audioTracks = declared;
    // Logged WITHOUT a video codec: this path reads the container's audio only, and
    // the video codec is not in hand here. `canPlayType` is still asked per track,
    // since the audio half of the string is what decides the answer.
    logAudioTracks(declared);

    // Whether the coder packages can handle a track the browser cannot, asked
    // BEFORE rendering so the note can promise decoding rather than warn about
    // silence. Only asked when it matters: a file the browser can play never loads
    // the coder bundle, so it is never paid for in the ordinary case.
    const chosen = declared[audioChoice];
    logDecoder('describe', {
      tracks: declared.length,
      chosen: chosen ? chosen.codec : 'NONE-THIS-FILE-HAS-NO-AUDIO-TRACK',
      playable: chosen ? chosen.playable : '(none)',
    });
    if (chosen && !chosen.playable) {
      const can = await decoderCanPlay(chosen.codec);
      logDecoder('capability', { codec: chosen.codec, canDecode: can });
      if (file !== audioSourceFile) return;
    }
    renderAudio();
    // Started AFTER the note is rendered, because it is not instant: this file has to
    // be written into the decoder's filesystem and its first window decoded.
    if (chosen && !chosen.playable && decoderCapability?.get(chosen.codec)) {
      logDecoder('start', { codec: chosen.codec, index: audioChoice });
      void startDecoding(file, audioChoice);
    } else if (chosen && !chosen.playable) {
      logDecoder('skipped', {
        codec: chosen.codec,
        reason: 'the decoder says it cannot decode this codec',
      });
    }
  } catch (error) {
    // An unreadable container is not a failure: it means there is nothing to offer,
    // which is a normal state for a format we do not parse.
    logDecoder('describe-failed', { error: String(error?.message ?? error) });
    // Rendered even on failure, so the row says "No audio track" rather than sitting
    // empty. The row always tells the truth about what was found, including nothing.
    renderAudio();
  }
}

/**
 * Decode a track the browser cannot, and mute the element so only our audio is heard.
 *
 * @param {File} file
 * @param {number} index Which audio track.
 */
async function startDecoding(file, index) {
  try {
    const resumeAt = els.video.currentTime;
    const wasPlaying = !els.video.paused;

    // The previous stream is released BEFORE the new one is built, so two MediaSources
    // are never open against the same element, which throws.
    if (releaseStream) {
      releaseStream();
      releaseStream = null;
    }

    const stream = await transcodeForElement(file, els.video, {
      trackIndex: index,
      // **Throttled to whole percent.** The conversion reports progress on every
      // internal step, which on a long film is hundreds of events a second, and logging
      // each one both floods the console past usefulness and costs real time in
      // `console.log` on a path that is already the slowest part of the feature. Only a
      // change of whole percent is worth a line.
      onProgress: (fraction) => {
        const percent = Math.round(fraction * 100);
        if (percent === lastTranscodePercent) return;
        lastTranscodePercent = percent;
        logDecoder('transcode-progress', { percent });
      },
    });
    // The file may have been replaced while the transcoder was starting.
    if (file !== audioSourceFile) {
      stream.revoke();
      logDecoder('abandoned', { reason: 'the file changed while decoding was starting' });
      return;
    }

    // The element must attach BEFORE production has anywhere to put its output, and
    // `transcodeForElement` deliberately does not wait for that. Swapping `src` is what
    // makes `sourceopen` fire.
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = stream.url;
    releaseStream = stream.revoke;
    transcodeStream = stream;
    // Our own re-source, not a new file: the metadata handler must not offer to resume
    // something the viewer is already watching.
    resourcingInternally = true;
    els.video.src = stream.url;
    els.video.load();

    // Back to where they were, once the stream can accept a seek.
    restorePosition(resumeAt, () => {
      if (wasPlaying) void els.video.play().catch(() => {});
    });
    logDecoder('started', { index, at: Number(resumeAt.toFixed(2)) });

    await stream.done;
  } catch (error) {
    // The decode failed, so the promise the note made (or would have made silently) is
    // now false. This is the ONE case where the audio row must speak: the viewer would
    // otherwise get silence with no explanation, which is the exact failure this
    // feature exists to remove.
    //
    // `decoderCapability` is deliberately NOT consulted here. It records what the
    // coders CLAIM they can decode, and a coder claiming it and the decode succeeding
    // are different facts; this path is the second one being false.
    decoderFailed = true;
    renderAudio();
    // CONSOLE ONLY, for now. Nothing is shown in the interface.
    logDecoder('decode-failed', { error: String(error?.message ?? error) });
  }
}

/**
 * Put the playhead back after a re-source, once the stream can actually accept it.
 *
 * **`loadedmetadata` is too early for a Media Source stream, and that was the bug.**
 * Measured on a five-minute dual-audio file: it fires with `duration === Infinity` and
 * `readyState 1`, and setting `currentTime` there is silently DROPPED, `seekable` is
 * empty, so the element has nowhere to seek to. The duration resolves a moment later and
 * playback starts from zero. Reported as "resume offered 13:05, switched the audio track,
 * landed at 0:02", and reproduced exactly: 240.95s became 2.54s.
 *
 * The arithmetic was never wrong, `Math.min(resumeAt, Infinity)` is `resumeAt`. Only the
 * moment was, which is why the position vanished with no error at all.
 *
 * So this waits for the RANGE rather than for an event that only means "the element
 * exists". `seekable` is the honest signal: empty until there is something to seek
 * within, and it covers the target only once the fragments for it have arrived.
 *
 * @param {number} target Where to put the playhead.
 * @param {() => void} [onRestored] Runs once, whether or not the seek succeeded.
 */
function restorePosition(target, onRestored) {
  const EVENTS = ['loadeddata', 'canplay', 'progress', 'durationchange'];
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    for (const event of EVENTS) els.video.removeEventListener(event, attempt);
    clearTimeout(ceiling);
    onRestored?.();
  };

  const attempt = () => {
    if (settled) return;
    const { seekable, duration } = els.video;

    // The rebuilt stream is SHORTER than the target, a track that ends earlier, or a
    // container that lost its tail. Seeking past the end throws, so go to the end and
    // stop waiting for a range that will never cover it.
    if (Number.isFinite(duration) && duration <= target + 0.5) {
      els.video.currentTime = Math.max(0, duration - 0.5);
      finish();
      return;
    }
    if (!seekable.length) return;
    if (seekable.end(seekable.length - 1) < target) return;

    els.video.currentTime = target;
    finish();
  };

  for (const event of EVENTS) els.video.addEventListener(event, attempt);
  // A ceiling, so a stream that never becomes seekable does not leave four listeners on
  // the element for the life of the page, and so `onRestored` runs either way, or a
  // playback that should have continued would stay paused forever.
  const ceiling = setTimeout(finish, 15000);
  attempt();
}

/**
 * Switch to a track, by whichever route the browser allows.
 *
 * @param {number} index
 */
async function selectAudioTrack(index) {
  const track = audioTracks[index];
  if (!track || audioBusy) return;
  audioChoice = index;

  // Path 1: the browser can do it. Preferred, because the browser then handles every
  // codec it can play, including the ones we cannot decode at any price we would pay.
  //
  // Only usable when the element is actually playing the ORIGINAL file. After a switch
  // the source is a rebuilt stream, and the browser's own track list there is a list of
  // one, so this has to fall through to rebuilding again, or the UI would claim a
  // track change that never happened.
  if (audioTracksSupported() && !releaseStream) {
    const list = [...els.video.audioTracks];
    if (list.length > audioTracks.length) {
      list.forEach((entry, at) => {
        entry.enabled = at === index;
      });
      renderAudio();
      return;
    }
  }

  // Path 2: rebuild the stream, keeping only this track.
  if (!audioSourceFile) {
    renderAudio();
    return;
  }

  // **Two rebuilds, and which one is right depends on the codec.** A track the browser
  // can play is REMUXED by mediabunny, which copies it and keeps every codec intact. A
  // track it cannot is TRANSCODED, because remuxing an E-AC-3 track would still hand the
  // element E-AC-3, which is silence. The transcoder is the same one the initial open
  // uses, so a switch here is the same operation as opening the file.
  const chosen = audioTracks[index];
  if (chosen && !chosen.playable && decoderCapability?.get(chosen.codec)) {
    audioBusy = true;
    renderAudio();
    // `startDecoding` sets `resourcingInternally` and restores the position itself.
    await startDecoding(audioSourceFile, index);
    audioBusy = false;
    renderAudio();
    return;
  }

  audioBusy = true;
  renderAudio();
  const resumeAt = els.video.currentTime;
  const wasPlaying = !els.video.paused;
  try {
    // Streaming into Media Source Extensions rather than building a whole file first:
    // playback starts after the first fragment instead of after the entire film has
    // been copied, and memory stays near a segment rather than near the file size.
    // Measured at 39 ms to a playable first frame on a small fixture.
    // The previous rebuilt stream is released BEFORE the new one is built, so two
    // MediaSources are never open against the same element, which throws.
    if (releaseStream) {
      releaseStream();
      releaseStream = null;
    }

    const { url, revoke, done } = await streamTrack(audioSourceFile, index);

    // The element must attach BEFORE production has anywhere to put its output, and
    // `streamTrack` deliberately does not wait for that, see its contract. Swapping
    // `src` is what makes `sourceopen` fire.
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = url;
    releaseStream = revoke;
    // Our own re-source, not a new file: the metadata handler must not offer to resume
    // something the viewer is already watching. Cleared by the handler itself, or by the
    // next real open.
    resourcingInternally = true;
    els.video.src = url;
    els.video.load();

    // Back to where they were. A new source starts at zero, so without this a viewer
    // who switched mid-film would lose their place.
    restorePosition(resumeAt, () => {
      if (wasPlaying) void els.video.play().catch(() => {});
    });

    // Production is awaited, so `audioBusy` covers the whole rebuild rather than only
    // the setup. Releasing it when `streamTrack` returned would allow a second switch
    // while the first stream was still being produced, and the second would revoke the
    // first's URL out from under the element.
    await done;
  } catch (error) {
    // CONSOLE ONLY, for now. Nothing is shown in the interface.
    logDecoder('switch-failed', { error: String(error?.message ?? error) });
  } finally {
    audioBusy = false;
    renderAudio();
  }
}

els.audioSelect.addEventListener('change', (event) => {
  void selectAudioTrack(Number(event.target.value));
});

// --- Volume ------------------------------------------------------------------
//
// The one control here a generic player ALSO has, so the only thing worth deciding is
// that the slider and the button compose.
//
// NOT a setting. The element keeps its volume across a file change, and the OS volume
// is the real preference, a second one stored here would fight it. That is why this
// differs from `difficulty`, which IS stored: the band is ours, the volume is not.

/**
 * The volume a slider position means.
 *
 * The slider is 0-100 for a reason that is not cosmetic: a linear slider runs straight
 * through the part of the range where hearing actually changes. Perceptual loudness is
 * roughly logarithmic, so a linear control spends half its travel on loud-to-louder,
 * where the ear can barely tell the difference, and rushes through the quiet end where
 * it can. The square is the standard cheap correction.
 *
 * @param {number} position 0..100
 */
function volumeScale(position) {
  const fraction = Math.min(1, Math.max(0, position / 100));
  return fraction * fraction;
}

/** The level to come back to after unmuting. One interaction's state, not a setting. */
let lastVolume = 100;

/**
 * Push the current volume onto the element and into the controls.
 *
 * `muted` is a separate property, so the icon reflects it rather than volume being
 * zero. Dragging the slider to the bottom therefore means "silent", not "muted", and
 * the icon keeps saying which of the two it is.
 */
function applyVolume() {
  const wantsMute = Number(els.volumeSlider.value) === 0;
  els.video.volume = volumeScale(Number(els.volumeSlider.value));
  // **The element is NOT muted while we transcode.** In the earlier Web Audio design it
  // had to be, because our audio came from a separate path and the element's own sound
  // would have doubled with it. Now the element plays the transcoded stream itself, so
  // its sound IS our sound, and muting it would silence the film.
  els.video.muted = wantsMute;

  // **The ICON reflects the viewer's intent, not the element's `muted`.** While the
  // decoder plays, the element is muted on purpose, and showing that as "muted" told
  // the viewer their sound was off while it was playing, which is the opposite of the
  // truth. `wantsMute` is the slider, which is the only thing the viewer controls.
  const label = wantsMute ? 'Unmute' : 'Mute';
  els.muteButton.setAttribute('aria-pressed', String(wantsMute));
  els.muteButton.setAttribute('aria-label', label);
  els.muteButton.title = label;
}

els.muteButton.addEventListener('click', () => {
  if (els.muteButton.getAttribute('aria-pressed') === 'true') {
    els.volumeSlider.value = String(lastVolume > 0 ? lastVolume : 100);
  } else {
    // Remembered before zeroing, so unmuting comes back to where you were rather than
    // making you guess.
    lastVolume = Number(els.volumeSlider.value) || lastVolume;
    els.volumeSlider.value = '0';
  }
  applyVolume();
});

els.volumeSlider.addEventListener('input', () => {
  if (Number(els.volumeSlider.value) > 0) lastVolume = Number(els.volumeSlider.value);
  applyVolume();
});

// --- Position reporting ------------------------------------------------------

/**
 * Tell the worker which cue is playing.
 *
 * `timeupdate` fires about four times a second, which is plenty: rows are per cue,
 * not per frame, and the YouTube path polls a 250ms timer for the same reason.
 *
 * @param {boolean} [force] A seek always reports, even onto the same cue, so the
 *   panel re-syncs after a jump backwards.
 */
function reportPosition(force = false) {
  if (!segments.length) return;
  const index = findActiveIndex(segments, els.video.currentTime);
  const paused = els.video.paused;
  if (!force && index === lastIndex && paused === lastPaused) return;
  lastIndex = index;
  lastPaused = paused;

  api.runtime.sendMessage({
    type: MSG.CONTENT_POSITION,
    target: TARGET.BACKGROUND,
    index,
    seconds: els.video.currentTime,
    paused,
  });
}

let lastRendered = -2;

/**
 * Redraw whatever belongs on screen right now, and record that it was drawn.
 *
 * Every redraw outside `onTimeUpdate` goes through here for two reasons. The cue to
 * draw is the PLAYING one, not the one that started most recently, so a redraw while
 * paused in a gap clears the finished line instead of resurrecting it, which is the
 * same bug `findPlayingIndex` exists to fix. And `lastRendered` has to be told, or the
 * next `timeupdate` sees an unchanged index, decides there is nothing to do, and
 * skips the draw entirely.
 */
function redrawCaptions() {
  lastRendered = captionIndex();
  renderCaptions(lastRendered);
}

/**
 * The cue that should be on screen, which is not the one that started last.
 *
 * `activeIndex` answers "which cue started most recently", the right question for a
 * transcript and the wrong one for a subtitle. Between a cue's end and the next
 * cue's start the answer is still the finished cue, and the render cache keyed on it
 * would consider the screen up to date and never run the fade. This returns -1 once
 * the cue has ended, so the ending is a state CHANGE and `renderCaptions` runs for
 * it exactly as it runs for a new line.
 *
 * @returns {number}
 */
function captionIndex() {
  return findPlayingIndex(segments, els.video.currentTime);
}

function onTimeUpdate() {
  reportPosition();
  // Keyed on the cue that should be SHOWING, not the one that started last, so the
  // end of a cue is a transition the renderer sees and can schedule a fade for.
  syncCaptions();
  paintTime();
  remember();
}

/**
 * Draw the caption for the current playhead, if it changed since the last draw.
 *
 * **Driven per animation frame while playing, which is what keeps captions in step at
 * any speed.** `timeupdate` fires about four times a second regardless of `playbackRate`,
 * so at 8x the playhead advances two seconds between updates and a cue boundary is
 * crossed up to two seconds late: measured, wrong-caption samples rose from 8 in 60 at 1x
 * to 33 in 71 at 8x. Rendering on the element's own frames instead makes the caption
 * follow the picture at playback speed rather than at the event's fixed rate, and reuses
 * the same `captionIndex` cache, so it draws only when the cue actually changes.
 */
function syncCaptions() {
  const index = captionIndex();
  if (index === lastRendered) return;
  lastRendered = index;
  renderCaptions(index);
}

/** @type {number|null} The running animation-frame handle while playing. */
let captionFrame = null;

/**
 * The per-frame caption loop, active only while playing.
 *
 * Stopped when paused or ended, because a paused frame needs no redraw and a loop that
 * ran forever would burn a frame's work per tick for nothing. It is restarted by the
 * `play` event.
 */
function captionTick() {
  captionFrame = null;
  if (els.video.paused || els.video.ended) return;
  syncCaptions();
  captionFrame = requestAnimationFrame(captionTick);
}

function startCaptionLoop() {
  if (captionFrame == null && !els.video.paused && !els.video.ended) {
    captionFrame = requestAnimationFrame(captionTick);
  }
}

function stopCaptionLoop() {
  if (captionFrame != null) {
    cancelAnimationFrame(captionFrame);
    captionFrame = null;
  }
}

for (const event of ['timeupdate', 'play', 'pause', 'ended']) {
  els.video.addEventListener(event, onTimeUpdate);
}
els.video.addEventListener('play', startCaptionLoop);
els.video.addEventListener('pause', stopCaptionLoop);
els.video.addEventListener('ended', stopCaptionLoop);
// The loop reads `playbackRate` through the element's clock, so a rate change needs no
// handler: the next frame simply sees the playhead further along. This is why the fix is
// per frame rather than a rate-scaled timer, which would have to be re-armed on every
// change and would drift from the element's own clock.
//
// **`seeking`, not only `seeked`.** `currentTime` is written at the START of a seek and
// `seeked` fires when the element has ARRIVED, which can be a frame or more later, and
// under a slow seek much later. For that window the caption is still the old cue while
// `currentTime` already reads the new one, which the sync rule forbids. So the caption is
// repainted the instant the position changes, and again on arrival.
els.video.addEventListener('seeking', () => {
  syncCaptions();
});
// `seeked`, not `seeking`: reported once the new position is real.
els.video.addEventListener('seeked', () => {
  reportPosition(true);
  // `redrawCaptions` uses the PLAYING cue, so seeking into a gap fades the finished
  // line rather than putting it back, and records what is on screen for the next
  // `timeupdate`.
  redrawCaptions();
});

// **The transport needs no handler for the transcoded audio any more.** The element
// plays our stream itself, so its own `play`, `pause` and `seek` ARE the audio's; the
// earlier design drove a separate decoder from these events and had to re-seek it in
// step. Nothing to keep in sync means nothing to get out of sync.

// --- The resume position -----------------------------------------------------
//
// Only the POSITION is remembered, never the file: the web platform does not expose
// a path (verified, `file.name` is a basename), and storing the bytes copies them
// (measured, a 256MB file measured 256MB on disk, and the same File twice measured
// 512MB). So the offer is what makes a re-pick feel like resuming.

const POSITION_KEY = 'playback-positions';
/** @type {Record<string, number>} */
let positions = {};
let lastStored = 0;

/** Persist the current position, throttled to one write every 5s. */
function remember() {
  if (!videoFile) return;
  const now = performance.now();
  if (now - lastStored < 5000) return;
  lastStored = now;
  const id = videoIdFor(videoFile);
  positions[id] = els.video.currentTime;
  // `api.storage` rather than `localStorage`: this is an extension page, and the
  // bucket is where the worker and the panel can read it too.
  api.storage[SETTINGS_AREA].set({ [POSITION_KEY]: positions }).catch(() => {});
}

/**
 * Forget the stored position for the current file.
 *
 * Called by "Start over", which has to mean it: leaving the position stored means the
 * offer returns on the next load asking whether you want to resume to the place you
 * just declined.
 */
function forgetPosition() {
  if (!videoFile) return;
  delete positions[videoIdFor(videoFile)];
  api.storage[SETTINGS_AREA].set({ [POSITION_KEY]: positions }).catch(() => {});
}

/**
 * Whether the next `loadedmetadata` is from OUR OWN source swap rather than a new file.
 *
 * Switching audio track replaces `els.video.src` with the rebuilt stream, and that fires
 * `loadedmetadata` again, so the handler offered to resume a film the viewer is already
 * watching, at a position they are already at. The offer is for a file being OPENED; an
 * internal re-source is not that, and the switch restores its own position anyway.
 *
 * A flag rather than a comparison of `currentSrc`, because both callers know which one
 * they are: `loadVideo` is opening a file, the switch is not.
 */
let resourcingInternally = false;

/**
 * How long the resume offer waits before it retires itself.
 *
 * A banner that sits on the picture until it is dismissed is a modal nobody asked for,
 * and this one covers the video. Ten seconds is long enough to read a timestamp and
 * decide, and short enough not to be in the way, the same reasoning as any toast.
 */
const RESUME_TIMEOUT_MS = 10000;

/** The pending auto-dismiss, so a manual dismissal cancels it. */
let resumeTimer = null;

/** Hide the offer and stop its timer. */
function dismissResume() {
  clearTimeout(resumeTimer);
  resumeTimer = null;
  els.resume.hidden = true;
}

/** Offer to resume, if a position was stored for this file. */
function offerResume() {
  if (!videoFile) return;
  const saved = positions[videoIdFor(videoFile)];
  if (typeof saved !== 'number' || !Number.isFinite(saved)) return;

  // Two ways a stored position is not worth offering: it is barely into the film,
  // or it is past the end of it. Both need the duration.
  //
  // The duration is NOT always known here. `loadVideo` calls this before the new
  // source has reported anything, so `els.video.duration` reads as NaN then.
  // `Number.isFinite(NaN)` is false, so the end test was SKIPPED and only the
  // two-second floor remained, which let an offer through for a position at the
  // very end of a short file: measured at 5.39s into a 6-second one, reported as
  // "Resume at 0:05?". It also made `switching audio offers no modal` fail
  // intermittently, because the offer can arrive from the pre-metadata call and
  // still be on screen ten seconds later when the test looked.
  //
  // An unknown duration is a reason to WAIT, not a reason to allow. The metadata
  // handler calls this again once the duration is real, so nothing is lost by
  // returning here.
  const duration = els.video.duration;
  if (saved <= 2) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (saved > duration - 5) return;

  els.resumeText.textContent = `Resume at ${timecode(saved)}?`;
  els.resume.hidden = false;
  els.resume.dataset.seconds = String(saved);

  // And it goes away on its own. Nothing else would ever dismiss it, and an offer that
  // outlives the moment it was relevant is a bar across the picture.
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(dismissResume, RESUME_TIMEOUT_MS);
}

/** Human-readable, `1:12:40` style. @param {number} seconds */
function timecode(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

els.resume.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.id === 'resume-go') {
    els.video.currentTime = Number(els.resume.dataset.seconds);
    // Seeking is not resuming, but calling `play()` straight after a seek does not
    // resume either: the seek aborts the pending play, the promise rejects with
    // `AbortError`, and a `.catch(() => {})` turns that into a film that sits paused at
    // the right position, the exact symptom this was meant to fix. Measured: the
    // element reported `paused: true` after the click while a plain `play()` outside the
    // handler succeeded, so the policy was never the problem. Wait for the seek to land.
    els.video.addEventListener('seeked', () => void els.video.play().catch(() => {}), { once: true });
  } else {
    // "Start over" did NOTHING but hide the banner. It fell through both branches, so the
    // playhead stayed where it was and the offer was simply gone, the button's whole
    // promise unkept, and unrecoverable, because `offerResume` only fires on metadata.
    els.video.currentTime = 0;
    // And the stored position has to go with it, or the offer returns on the next load
    // and asks whether you want to resume to where you already declined to be.
    forgetPosition();
    void els.video.play().catch(() => {});
  }

  dismissResume();
});

// --- Messages ---------------------------------------------------------------

/**
 * Reply to a request, or report that there is nothing to reply with.
 *
 * @param {any} sendResponse
 * @param {any} payload
 */
function reply(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch {
    // The port closed while we were working, the worker restarted, or the panel
    // went away. Nothing to do about it and nothing worth logging.
  }
}

/** @param {string|null} languageCode */
function trackFor(languageCode) {
  if (!languageCode) return null;
  return tracks.find((track) => track.languageCode === languageCode) ?? null;
}

/**
 * Which track to load when the worker did not name one.
 *
 * **This is the fix for "no subtitles appear at all".** `settings.studyLanguage`
 * defaults to `null`, so the FIRST request for a video is always
 * `PROVIDE { languageCode: null }`, and a viewer that answered "no such track"
 * produced no transcript for any file, ever, no matter how many tracks were found.
 *
 * The preference order is deliberate:
 *
 *   1. **A track in a language this extension can mark**, Chinese or Japanese,
 *      because marking is the point.
 *   2. **Any readable text track**, so a French film still opens with its French
 *      subtitles.
 *   3. **Null**, meaning there is genuinely nothing to show.
 *
 * @returns {object|null}
 */
function pickDefaultTrack() {
  const usable = tracks.filter((track) => track.kind !== 'image' && !(track.segments === null && track.error));
  if (!usable.length) return null;

  // `zh` and `ja` are `src/learn/data/index.json`'s languages, the ones with a word
  // list, and therefore the only ones that mark anything.
  const markable = usable.find((track) => {
    const base = track.languageCode.split('-')[0];
    return base === 'zh' || base === 'ja';
  });
  return markable ?? usable[0];
}

/**
 * Resolve the track for a request, applying the default when none was named.
 *
 * @param {string|null} languageCode
 * @returns {{track: object|null, fellBack: boolean}}
 */
function resolveTrack(languageCode) {
  const named = trackFor(languageCode);
  if (named) return { track: named, fellBack: false };
  // Only fall back when nothing was ASKED for. A named language that does not exist
  // is a genuine miss, the worker holds a stale choice, and silently substituting
  // another language would put different text under a heading that says otherwise.
  if (languageCode) return { track: null, fellBack: false };
  return { track: pickDefaultTrack(), fellBack: true };
}

/**
 * The `fetched` shape the worker expects from PROVIDE / FETCH_TRACK.
 *
 * Takes a RESOLVED track rather than a language code, because resolving is where the
 * default is chosen and doing it in here would mean every caller had to remember to
 * ask for the fallback.
 *
 * The error goes INSIDE `fetched.error` rather than as a top-level failure, because
 * the worker reads it to tell a failed translation from a failed fetch and takes a
 * different branch for each.
 *
 * @param {object|null} track
 * @param {string} languageCode
 * @param {boolean} fellBack
 */
function fetchTrack(track, languageCode, fellBack = false) {
  // The language reported back is the TRACK's, not the one requested, the worker
  // adopts it as `studyLang`, and adopting the request (`null`) would leave the
  // choice unset so every later refresh fell back again.
  const code = track?.languageCode ?? languageCode;

  if (!track) {
    return { languageCode: code, translateTo: null, segments: [], error: errorText('VIEWER005') };
  }
  if (!track.segments) {
    return {
      languageCode: code,
      translateTo: null,
      segments: [],
      error: errorText('VIEWER002', track.error ?? 'that track has not been read'),
    };
  }
  if (!track.segments.length) {
    return {
      languageCode: code,
      translateTo: null,
      segments: [],
      error: track.error ?? errorText('VIEWER002', 'no cues in that file'),
    };
  }
  void fellBack;
  return { languageCode: code, translateTo: null, segments: track.segments, error: track.error ?? null };
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== TARGET.CONTENT) return false;

  switch (message.type) {
    case MSG.DESCRIBE:
      reply(sendResponse, { ok: Boolean(videoFile), video: describeVideo() });
      return false;

    case MSG.PROVIDE:
    case MSG.FETCH_TRACK: {
      // Both are answered the same way; FETCH_TRACK wraps its result and PROVIDE
      // does not, which is the only difference and is the worker's contract.
      const direct = message.type === MSG.FETCH_TRACK;
      const { track, fellBack } = resolveTrack(message.languageCode ?? null);

      /** @param {any} fetched */
      const send = (fetched) =>
        reply(
          sendResponse,
          direct ? fetched : { ok: Boolean(fetched.segments.length), fetched, video: describeVideo() },
        );

      /** An embedded track's cues have to be read before they can be returned. */
      const needsReading = track && !track.segments && track.kind === 'text' && videoFile;

      if (needsReading) {
        // Reading a film's cues takes real time, it walks the media, so the reply
        // is deferred. This is the one genuinely slow request in the viewer, and why
        // the worker gives these two messages the long timeout.
        ensureSegments(track)
          .then(() => send(fetchTrack(track, message.languageCode ?? null, fellBack)))
          .catch((error) =>
            send({
              languageCode: track.languageCode,
              translateTo: null,
              segments: [],
              error: String(error?.message ?? error),
            }),
          );
        return true; // async reply
      }

      send(fetchTrack(track, message.languageCode ?? null, fellBack));
      return false;
    }

    case MSG.SET_TRACK: {
      // The worker already holds these, from a cache hit. Handed back only so
      // position reporting has something to measure against.
      segments = Array.isArray(message.segments) ? message.segments : [];
      activeTrackLanguage = message.languageCode ?? activeTrackLanguage;
      // Force the next report: the previous cue belonged to whatever was loaded
      // before, and suppressing the first report would leave the panel waiting for a
      // change that may never come on a paused video.
      lastIndex = -2;
      lastRendered = -2;
      // The worker chose this track, so the list and dictionary follow it, the same
      // path the viewer's own default-track load takes.
      void prepareMarks(activeTrackLanguage).then(() => {
        for (const cue of segments) delete cue.marked;
        markSegments();
      });
      reply(sendResponse, { ok: true });
      return false;
    }

    case MSG.CONTENT_SEEK:
      if (Number.isFinite(message.seconds)) els.video.currentTime = message.seconds;
      reply(sendResponse, { ok: true });
      return false;

    default:
      return false;
  }
});

// --- Controls ----------------------------------------------------------------

const click = (id, handler) => document.getElementById(id)?.addEventListener('click', handler);

click('play', () => {
  if (els.video.paused) void els.video.play();
  else els.video.pause();
});

/**
 * The play button's icon and name, swapped in one place.
 *
 * The two paths are the triangle and the pair of bars, written here rather than
 * toggled with a CSS rule, because a swap that only changed the picture would leave
 * the accessible name disagreeing with it.
 */
function syncPlayIcon() {
  const path = /** @type {SVGPathElement} */ (document.getElementById('play-path'));
  const button = document.getElementById('play');
  if (els.video.paused) {
    path.setAttribute('d', 'M8 5.5v13l11-6.5z');
    button.setAttribute('aria-label', 'Play');
    button.title = 'Play';
  } else {
    path.setAttribute('d', 'M7 5.5h3.2v13H7zM13.8 5.5H17v13h-3.2z');
    button.setAttribute('aria-label', 'Pause');
    button.title = 'Pause';
  }
}

els.video.addEventListener('play', syncPlayIcon);
els.video.addEventListener('pause', syncPlayIcon);

click('back', () => {
  els.video.currentTime = Math.max(0, els.video.currentTime - 5);
});

click('forward', () => {
  els.video.currentTime = Math.min(els.video.duration || Infinity, els.video.currentTime + 5);
});

/**
 * Cue stepping, the control a generic player cannot have.
 *
 * `+0.05` on the step so landing "on" a boundary is INSIDE the cue rather than a
 * hair before it, where float rounding puts you in the previous one. This is the
 * kind of thing that looks like an off-by-one and is really a seek artefact.
 */
click('prev-cue', () => {
  if (!segments.length) return;
  const index = activeIndex();
  const target = index <= 0 ? segments[0].start : segments[index - 1].start;
  els.video.currentTime = target + 0.05;
});

click('next-cue', () => {
  const index = activeIndex();
  if (index < 0 || !segments.length) return;
  const next = segments[index + 1];
  if (next) els.video.currentTime = next.start + 0.05;
});

click('replay-cue', () => {
  const index = activeIndex();
  if (index >= 0) els.video.currentTime = segments[index].start + 0.05;
});

document.getElementById('speed').addEventListener('change', (event) => {
  setSetting('defaultSpeed', event.target.value);
});

click('captions', () => setSetting('captionsOn', !settings.captionsOn));

for (const chip of document.querySelectorAll('[data-placement]')) {
  chip.addEventListener('click', () => setSetting('captionPlacement', chip.dataset.placement));
}

document.getElementById('reading').addEventListener('change', (event) => {
  setSetting('romaji', event.target.value);
});

document.getElementById('marks').addEventListener('change', (event) => {
  setSetting('markStyle', event.target.value);
});

document.getElementById('caption-size').addEventListener('change', (event) => {
  const size = Number(event.target.value);
  if (Number.isFinite(size)) setSetting('captionSize', size);
});

document.getElementById('word-list').addEventListener('change', (event) => {
  // An empty value means "choose for me", which is `null`, a real choice rather than
  // a missing one, so it is stored as such.
  setSetting('listId', event.target.value || null);
});

document.getElementById('study-track').addEventListener('change', (event) => {
  settings.studyLanguage = event.target.value || null;
  setSetting('studyLanguage', settings.studyLanguage);
  // A different study track is a different transcript: reload its cues and re-align
  // the gloss to them, rather than leaving the old cues under the new heading.
  void loadDefaultTrack();
});

document.getElementById('gloss-track').addEventListener('change', (event) => {
  settings.glossLanguage = event.target.value || null;
  setSetting('glossLanguage', settings.glossLanguage);
  void loadGlossTrack(trackFor(settings.studyLanguage) ?? pickDefaultTrack());
});

document.getElementById('threshold').addEventListener('change', (event) => {
  setSetting('threshold', event.target.value ? Number(event.target.value) : null);
});

/**
 * Whether the viewer was in fullscreen when PiP started.
 *
 * Recorded on ENTRY, not read on exit, and that distinction is the whole fix: the browser
 * drops element fullscreen the moment PiP opens, so by the time anyone leaves PiP the
 * answer is always "no". Reading it at exit is a condition that can never be true, which
 * is what the first version of this did.
 */
let fullscreenBeforePip = false;

click('pip', () => {
  if (document.pictureInPictureElement) {
    // Leaving PiP RESTORES fullscreen, if the viewer was in it when PiP started.
    //
    // It has to happen HERE, in the click handler, and that is not a preference, a user
    // gesture is required and `leavepictureinpicture` is not one. Measured both ways:
    //
    //   from the LEAVE event:     refused (no gesture)  -> stayed not-fullscreen
    //   from this click:          SUCCEEDED             -> fullscreen back
    //
    // So the browser drops fullscreen when PiP opens and never puts it back, and the
    // only place the page can restore it is the gesture that closes PiP.
    const wanted = fullscreenBeforePip;
    fullscreenBeforePip = false;
    void document
      .exitPictureInPicture()
      .then(() => (wanted ? els.picture.requestFullscreen() : undefined))
      .catch(() => {});
    return;
  }

  // The state is captured BEFORE PiP opens, because opening it is what drops it.
  fullscreenBeforePip = Boolean(document.fullscreenElement);
  void els.video.requestPictureInPicture().catch(() => {
    fullscreenBeforePip = false;
  });
});

// Fullscreen the PICTURE, not the video. This is what lets the bar be a sibling of
// the fullscreened element; `video.requestFullscreen()` takes the media element alone
// and only that element and its descendants are rendered, so no overlay bar could
// ever appear over it.
/**
 * Fullscreen, and the one thing the page CANNOT see.
 *
 * **The Fullscreen API describes elements, not windows.** When the user presses F11, or
 * maximises a window, or PiP closes back into a fullscreen tab, `document.fullscreenElement`
 * stays `null`, the page was not asked, it is simply displayed larger. There is no API
 * for that state and no reliable way to detect it, so the button does not try. It manages
 * ELEMENT fullscreen and labels itself honestly for what it will do.
 *
 * ## What an earlier version got wrong, since it is the tempting mistake
 *
 * It compared `window.innerHeight` against `window.screen.height` to guess the window's
 * state, and refused to request fullscreen when they matched. That heuristic cannot tell
 * "the window is fullscreen" from "there is no browser chrome", and the second is true
 * in ANY maximised window, where those values differ by a few pixels of title bar. So the
 * button reported "Exit fullscreen" while nothing was fullscreen and did nothing when
 * pressed. Measured in a headless browser, which has no chrome at all:
 *
 *     before the click: {"innerHeight":720,"screenHeight":720,"windowIsFullscreen":true}
 *     after the click:  {"fullscreenElement":null}          <- it never asked
 *
 * A heuristic that can only ever produce a false positive is worse than not having one,
 * so this is gone rather than tuned.
 */
function syncFullscreenButton() {
  // The BUTTON'S OWN action is the label: element fullscreen in, element fullscreen out.
  // `innerHeight === screen.height` is deliberately not part of it, see above.
  const on = Boolean(document.fullscreenElement);
  const label = on ? 'Exit fullscreen' : 'Fullscreen';
  els.fullscreenButton.setAttribute('aria-pressed', String(on));
  els.fullscreenButton.setAttribute('aria-label', label);
  els.fullscreenButton.title = label;
}

click('fullscreen', () => {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
    return;
  }
  // Unconditionally, because `fullscreenElement === null` means element fullscreen is
  // available, that is exactly what the check above established. Refusing here is how
  // the button became a no-op in a maximised window.
  void els.picture.requestFullscreen().catch(() => {
    setStatus('This browser refused fullscreen for this page.', true);
  });
});

// Entering Picture-in-Picture DROPS element fullscreen. Measured:
//
//     element fullscreen:  fsElement "picture"
//     entered PiP:         fsElement null      <- the browser let go to open the window
//     exited PiP:          fsElement null      <- and does not put it back
//
// The restore lives in the PiP button's handler rather than in `leavepictureinpicture`,
// because the latter is not a user gesture and `requestFullscreen` is refused there,
// tried first, and measured failing. See the handler above.

document.addEventListener('fullscreenchange', () => {
  syncFullscreenButton();
  showBar();
  measureBar();
  scheduleHide();
});

window.addEventListener('resize', () => {
  // Still measured, because `--bar-offset` decides where the captions sit and the bar's
  // height changes with the row. Only the fullscreen guess is gone.
  measureBar();
});

/**
 * Click the picture to play/pause.
 *
 * Not a nicety: when the bar has hidden itself it sets `pointer-events: none`, so a
 * click in that region lands on the picture. With no handler there the click does
 * nothing at all, which reads as the app being frozen. A click landing on a control
 * is left alone, or pressing a button would also toggle playback under it.
 */
els.stage.addEventListener('click', (event) => {
  // A control, or a caption word being hovered for its definition. Neither should
  // toggle playback, pressing a button and pausing the film underneath it is the
  // obvious bug, and pausing because you pointed at a word is the subtle one.
  if (event.target.closest('.bar') || event.target.closest('.captions')) return;
  if (els.video.paused) void els.video.play();
  else els.video.pause();
});

// --- Wiring -----------------------------------------------------------------

els.pickFiles.addEventListener('change', () => {
  void acceptFiles(els.pickFiles.files ?? []);
  // Reset so choosing the same file twice fires `change` again. Without this,
  // re-picking a corrected subtitle file is silently ignored.
  els.pickFiles.value = '';
});

// Drag and drop, because it is what people try first. The picker stays as the
// discoverable version and both routes end in the same handler.
for (const event of ['dragenter', 'dragover']) {
  els.stage.addEventListener(event, (dragged) => {
    dragged.preventDefault();
    els.stage.classList.add('dragging');
  });
}
for (const event of ['dragleave', 'drop']) {
  els.stage.addEventListener(event, () => els.stage.classList.remove('dragging'));
}
els.stage.addEventListener('drop', (dropped) => {
  dropped.preventDefault();
  void acceptFiles(dropped.dataTransfer?.files ?? []);
});

// The blob URL is scoped to this document, so a reload loses the file. Revoke on the
// way out rather than leaving the browser to clean up an orphan.
window.addEventListener('pagehide', () => {
  remember();
  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
});

// Announce. This is how the worker learns which tab is a source, it cannot discover
// the page by URL, because our own pages have no readable `tab.url`.
//
// Retried once, later, because the FIRST attempt can legitimately fail: the service
// worker may be starting up, and on an extension reload this page can outlive the
// worker that would receive it. A single failed announcement leaves the panel
// reporting "no supported video" while this page plays perfectly, so one retry is
// worth it, and the worker looks for open viewer tabs itself, so even a lost
// announcement is recoverable.
function announce(attempt = 0) {
  api.runtime.sendMessage({ type: MSG.VIEWER_READY, target: TARGET.BACKGROUND }).catch(() => {
    if (attempt === 0) setTimeout(() => announce(1), 500);
    else setStatus('Reopen this page from the toolbar menu.', true);
  });
}

// --- Start -------------------------------------------------------------------

// The stored positions, so an offer can be made as soon as a file is opened.
void api.storage[SETTINGS_AREA]
  .get(POSITION_KEY)
  .then((stored) => {
    if (stored?.[POSITION_KEY] && typeof stored[POSITION_KEY] === 'object') {
      positions = stored[POSITION_KEY];
    }
  })
  .catch(() => {});

els.video.addEventListener('loadedmetadata', () => {
  measureBar();
  paintTime();
  paintDifficulty();
  // Logged BEFORE the resume-prompt early return below, so a file that triggers the
  // prompt is still reported. A media error has no metadata at all, so the failure
  // case is logged from the error handler instead.
  if (videoFile) logFile(videoFile, els.video);
  // Not for our own re-source. See `resourcingInternally`.
  if (resourcingInternally) {
    resourcingInternally = false;
    return;
  }
  offerResume();
});

// Hover a caption word for its definition, with the same popover the panel draws.
//
// Attached to BOTH placements, because only one is visible at a time and the handler
// is delegated, one listener per container rather than one per token, which for a
// film's captions would be thousands.
//
// The overlay is `pointer-events: none` so it cannot swallow clicks meant for the
// picture, which also means it cannot RECEIVE hover, hence the listener on the
// below strip and on the picture, and `pointer-events: auto` restored on the tokens
// themselves in the stylesheet.
attachHover(els.picture, definitionFor);
attachHover(els.below, definitionFor);

// Leaving the caption area hides the card. `mouseover`/`mouseout` on a token covers
// moving between words; this covers leaving the strip entirely, which has no token
// to report it.
els.stage.addEventListener('mouseleave', hidePopover);

applySettings();
applyVolume();
syncFullscreenButton();
render();
setStatus('Ready.');

// One line per page load, so a pasted log says which browser and build it came from
// and what the browser claims about the codecs being warned about. See
// `diagnostics.js`, which is temporary.
logBanner();

// The list manifest, so the caption pickers are populated as soon as the page opens
// rather than only after a file is chosen. Fire-and-forget: the captions work without
// it, they just cannot offer a list to choose.
void loadIndex(api.runtime.getURL('src/learn/data/index.json'))
  .then((index) => {
    listIndex = index;
    renderTrackPickers();
  })
  .catch(() => {});

announce();
