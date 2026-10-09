/**
 * The video reader — a SOURCE, one we host.
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
 * and it reports CONTENT_POSITION as playback advances. READER_READY and
 * READER_CHANGED announce it on load and when a file is chosen.
 *
 * The service worker does not know this page exists. It finds it because the page
 * announces itself, because `tab.url` is empty for a `chrome-extension://` document
 * without the `tabs` permission — which this extension deliberately does not
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
 * NOT own the mark RULES — `src/learn/marking.js` does, shared with the worker, so
 * the captions and the panel's transcript cannot disagree about what a mark is. It
 * does not own the mark LOOK — `src/common/marks.css` does, for the same reason.
 */

import { MSG, TARGET } from '../common/messages.js';
import { errorText } from '../common/errors.js';
import { findActiveIndex, alignSecondary } from '../common/transcript.js';
import { parseSubtitles, languageFromFileName, SUBTITLE_EXTENSIONS } from './subtitles.js';
import { readMatroskaTracks, readMatroska, imageCodecName } from './matroska.js';
import { segment } from '../learn/segment.js';
import { indexDictionary, loadIndex, dictionaryPathFor, lookup, levelOf, levelColour } from '../learn/wordlist.js';
import { markLine, listCoversLanguage, listForLanguage } from '../learn/marking.js';
import { SETTINGS_AREA, storageKey as SETTINGS_KEY } from '../common/settings.js';
import { renderReading, setReadingSettings, attachHover, showEntry, hide as hidePopover } from '../common/marks.js';
import { audioTracksSupported, listAudioTracks, streamTrack } from './audio-tracks.js';

/**
 * The extension API namespace — `browser` where it exists (Chrome 148+ and always
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
  audioButton: /** @type {HTMLButtonElement} */ (document.getElementById('audio')),
  audioField: /** @type {HTMLElement} */ (document.getElementById('audio-field')),
  audioSelect: /** @type {HTMLSelectElement} */ (document.getElementById('audio-track')),
  audioNote: /** @type {HTMLElement} */ (document.getElementById('audio-note')),
};

// --- Settings ----------------------------------------------------------------
//
// Read directly from `chrome.storage`, because this is our own page and storage is
// the SOURCE OF TRUTH — the same arrangement the worker subscribes to. Writing goes
// the same way, so a change made here and a change made in the panel both land in
// the bucket and both reach every listener, including the worker's.
//
// The bucket and key come from `settings.js` so there is one definition of where
// settings live. The reader does NOT import the registry's `defaults()` — it needs
// six values and renders none of them as controls, and importing the whole thing
// would pull in every option list for no use. The KEYS are the contract.
//
// **Every write is a MERGE, never a whole-object replace.** The reader knows about
// six settings; the panel has fourteen. Writing `settings` wholesale would delete
// every one the reader had never heard of — the word list, the threshold, the text
// size — the moment anyone touched a caption control. So the bucket is read, the one
// key is set, and the rest is carried across untouched.

const DEFAULTS = {
  captionsOn: true,
  captionPlacement: 'overlay',
  romaji: 'above',
  toneStyle: 'marks',
  markStyle: 'underline',
  defaultSpeed: '1',
  captionSize: 20,
  // Whether the difficulty band is drawn under the scrubber. Reader-only, and in the
  // registry because it is a preference that persists — unlike volume, which the
  // element keeps on its own and which the OS volume should really own.
  difficulty: true,
  // SHARED with the panel, not reader-owned. The word list, the threshold and the two
  // subtitle tracks are one preference each: the reader draws the same transcript the
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
  if (['0.5', '0.75', '1', '1.25'].includes(String(stored.defaultSpeed))) {
    next.defaultSpeed = String(stored.defaultSpeed);
  }
  const size = Number(stored.captionSize);
  if (Number.isFinite(size)) next.captionSize = Math.min(34, Math.max(12, Math.round(size)));
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

// **This is what makes the reader and the panel agree.** The panel writes a
// setting, the bucket changes, and this listener fires — because the storage API's
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
// both places. This is the reader's own copy of the dictionary load — it does not
// ask the worker, because the reader is a source, not a client of one, and a round
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
 * dictionary arrives. That ordering is deliberate — a subtitle track that appears a
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
    // otherwise — the same resolution the pickers show, through `resolvedList`, so
    // the control and the marking cannot disagree.
    void languageCode;
    const list = resolvedList();
    if (!list) return;
    listId = list.id;
    // A different language can mean a different dictionary, so it is reloaded rather
    // than reused — the alternative marks Japanese text against Chinese headwords.
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
 * Stores the TOKENS on each cue so a re-mark does not re-segment — segmentation is
 * the expensive half and it does not depend on the settings, only on the text.
 */
function markSegments() {
  if (!dictionary || !segments.length) return;

  const list = resolvedList();
  // A list that cannot grade this language would find nothing and render the
  // captions plain with no explanation, which reads as a broken feature. Skipping
  // the work says the same thing more cheaply — and the captions being plain for a
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

  renderCaptions(activeIndex());
  // The band is painted FROM these marks, so it has to be repainted when they change —
  // otherwise switching word list or threshold recolours every word and leaves the
  // timeline showing the levels of the previous list.
  paintDifficulty();
}

/**
 * The level to mark from, for a list.
 *
 * The first level, matching the panel's own default when the learner has not
 * chosen: nothing is guessed about their ability. The reader has no threshold
 * control — that is a panel-side setting — so it marks from the bottom, which
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
 * A reader has one subtitle track on screen, unlike the panel which has two, so the
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
 *   - a SIDECAR file, parsed at pick time (cheap — it is a text file)
 *   - a track INSIDE the video, extracted lazily on first request (not cheap — it
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
 * A local file can carry more than one subtitle track — a Chinese traditional and an
 * English, say — so the reader draws both lines exactly as the panel does. Alignment
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
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
  const code = /^([A-Z]{2,6}\d{3})/.exec(text);
  if (code) els.status.dataset.code = code[1];
  else delete els.status.dataset.code;
}

/** @param {File} file */
function isSubtitleFile(file) {
  const name = file.name.toLowerCase();
  return SUBTITLE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** @param {File} file */
function isVideoFile(file) {
  const name = file.name.toLowerCase();
  return file.type.startsWith('video/') || name.endsWith('.mkv') || name.endsWith('.mp4') || name.endsWith('.webm');
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
 * `File.slice()` does not read anything — it is a view — and the `arrayBuffer()` it
 * returns reads only that slice. So a multi-gigabyte film costs one window at a
 * time and never the whole file.
 *
 * @param {File} file
 */
function readerFor(file) {
  return {
    size: file.size,
    read: async (offset, length) => {
      const end = Math.min(offset + length, file.size);
      const buffer = await file.slice(offset, end).arrayBuffer();
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
    setStatus(errorText('READER002', 'no video or subtitle file in that selection'), true);
    return;
  }
  render();

  // Tell the worker there is something to read now. This is what makes the reader
  // work when the side panel was ALREADY open: `READER_READY` fired once, on an
  // empty page, so without this the worker never learned a file had been chosen and
  // the panel stayed blank while the film played.
  notifyChanged();
}

/**
 * "Look again" — the reader's content changed.
 *
 * Sent fire-and-forget: the worker resolves the active tab, so there is nothing to
 * retry against and nothing to report if it is missed. The next cue change or the
 * next `DESCRIBE` recovers.
 */
function notifyChanged() {
  void api.runtime
    .sendMessage({ type: MSG.READER_CHANGED, target: TARGET.BACKGROUND })
    .catch(() => {});
}

/**
 * Open a video file, and find whatever subtitles it carries.
 *
 * `async` because discovery reads the container. It is cheap — only the `Tracks`
 * element — but it is a read, and the video must be usable while it happens, so
 * playback starts first and the track list fills in after.
 *
 * @param {File} file
 */
async function loadVideo(file) {
  // A stream from the previous file has to be torn down before its source goes away,
  // or its MediaSource stays attached and its object URL keeps the blob alive.
  // `releaseStream` revokes the rebuild's URL, so this must NOT revoke `videoObjectUrl`
  // as well — after a switch that variable holds the SAME MediaSource URL, and
  // revoking it twice detaches a source the element may still be reading.
  if (releaseStream) {
    releaseStream();
    releaseStream = null;
  } else if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl);
  }

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
  renderCaptions(-1);
  offerResume();

  // A file the browser cannot decode is the one failure it will not tell us about
  // in advance. `canPlayType` is useless here — it answers about the CONTAINER, not
  // the codecs inside, and returns empty even for files Chrome then plays. So the
  // only honest detection is the error event, after trying. This is also the limit
  // of MKV support: the CONTAINER is readable by us, but whether its video DECODES
  // is the browser's business, and for HEVC it often will not.
  els.video.addEventListener(
    'error',
    () => {
      const code = els.video.error?.code;
      setStatus(errorText('READER003', code ? `media error ${code}` : undefined), true);
    },
    { once: true },
  );

  void els.video.play().catch(() => {
    // Autoplay is blocked until the user interacts. Not an error and not worth a
    // message: the controls are right there.
  });

  // A video dropped without a `.mkv` extension is still worth trying — the
  // container, not the filename, decides whether there are tracks in it.
  try {
    await loadEmbeddedTracks(file);
  } catch (error) {
    // A container we cannot parse is not a reason to refuse the video. It means
    // there are no embedded tracks we can offer, which is a normal state.
    setStatus(`Could not read subtitle tracks from this video (${String(error?.message ?? error)}). Use a .srt file.`, true);
  }

  // Listed after playback starts, so the control never delays the video. The choice
  // resets per file: a track index means nothing across two different files.
  audioChoice = 0;
  void describeAudio(file);

  // Load a track for the CAPTIONS, without waiting for the worker to ask.
  //
  // The worker asks for a track when the side panel needs the transcript, and on a
  // cache hit it hands the cues back with `SET_TRACK` rather than fetching — so the
  // usual flow does give us cues. But the reader must also work with NO panel at
  // all, and then nothing ever asks, and the captions stayed blank while the film
  // played. So the default track is loaded here, and `SET_TRACK` later replaces it
  // with whatever the worker chose — which is the same list in the ordinary case.
  void loadDefaultTrack();

  render();
}

/**
 * Load the track the reader would pick, so the captions work with no panel open.
 *
 * The STUDY track first, then the gloss — the preference, or the next readable track
 * that is not the study one. Two lines when the file has two tracks, one when it has
 * one, which is what the panel does beside the video.
 *
 * Deliberately fire-and-forget and deliberately not reported as an error: a file
 * whose cues cannot be read still plays, and the panel — when there is one — will say
 * why in its own status line.
 */
async function loadDefaultTrack() {
  // The learner's own choices win; otherwise the reader picks. This is the same
  // preference the panel reads, so a track chosen in the panel's dropdown is the one
  // the captions draw.
  const study = trackFor(settings.studyLanguage) ?? pickDefaultTrack();
  if (!study) return;
  try {
    segments = await ensureSegments(study);
    activeTrackLanguage = study.languageCode;
    lastIndex = -2;
    lastRendered = -2;
    // The list follows the track, so the dictionary is loaded for THIS language
    // before anything is marked. Fire-and-forget: the captions are on screen already
    // and gain their marks when the dictionary lands.
    void prepareMarks(study.languageCode);
    renderCaptions(activeIndex());
    // The gloss, if there is a second track. Awaited only to align it; the captions
    // are already on screen without it.
    void loadGlossTrack(study);
  } catch {
    // A track that cannot be read is normal for an image-based subtitle, and the
    // panel reports it. Nothing to say here.
  }
}

/**
 * Load the second subtitle track and align it to the first.
 *
 * **The reader can show two lines because a local file can carry two tracks** —
 * Chinese traditional and English in the same MKV, for instance. That is the same
 * arrangement the panel already has, drawn over the video instead of beside it, so
 * the alignment comes from the shared `alignSecondary` rather than a second
 * implementation with its own drift tolerance.
 *
 * A track that cannot be read, or a file with only one, leaves the gloss empty — and
 * the CSS collapses the empty line rather than leaving a blank card.
 *
 * @param {object} study
 */
async function loadGlossTrack(study) {
  const chosen = trackFor(settings.glossLanguage);
  // A second track the learner chose, or the first readable one that is not the study
  // track. Never the same track twice: a "gloss" identical to the line above it is
  // noise, not a translation.
  const gloss =
    chosen && chosen !== study
      ? chosen
      : tracks.find((track) => track !== study && track.kind === 'text' && !track.error);
  if (!gloss || gloss === study) {
    glossLines = [];
    renderCaptions(activeIndex());
    return;
  }
  try {
    const cues = await ensureSegments(gloss);
    // Aligned by start time with a drift tolerance, so an out-of-sync second track
    // leaves the line blank rather than pairing it with the wrong cue.
    glossLines = alignSecondary(segments, cues);
    renderCaptions(activeIndex());
  } catch {
    glossLines = [];
    renderCaptions(activeIndex());
  }
}

/** @param {File[]} files */
async function loadSubtitles(files) {
  for (const file of files) {
    // Read as bytes, not text, so `subtitles.js` can detect the encoding rather than
    // compounding a guess about it with a default.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { segments: cues, format, encoding, error } = parseSubtitles(bytes, file.name);

    const languageCode = languageFromFileName(file.name);

    // Replace a track for the same language rather than listing both, so picking a
    // corrected version of the same file does not leave the old one behind.
    tracks = tracks.filter((track) => !(track.source === 'file' && track.languageCode === languageCode));
    tracks.push({ languageCode, name: file.name, source: 'file', segments: cues, error, format, encoding });
  }

  const usable = tracks.filter((track) => track.segments?.length);
  if (!usable.length) {
    const first = tracks[0];
    setStatus(errorText('READER002', first?.error ?? 'no subtitle cues'), true);
  } else if (usable.length === 1) {
    setStatus(`${usable[0].segments.length} cues · ${usable[0].format} · ${usable[0].encoding}`);
  } else {
    setStatus(`${usable.length} subtitle tracks`);
  }
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
  const found = await readMatroskaTracks(readerFor(file));
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
            ? errorText('READER004', imageCodecName(track.codec) ?? track.codec)
            : `unsupported subtitle format (${track.codec})`,
      format: track.codec,
      encoding: 'utf-8',
    });
  }

  tracks = [...fromFiles, ...embedded];

  if (!tracks.length) {
    setStatus(errorText('READER005'), true);
    return;
  }

  setStatus(`${tracks.length} subtitle track${tracks.length === 1 ? '' : 's'} in this video`);
  // The track pickers are populated only once the tracks are KNOWN, which is after
  // the container has been read. Rendering them earlier left them empty — a picker
  // offering nothing to choose while the status line says there are three tracks is
  // the confusing half of the two being out of step.
  renderTrackPickers();
}

/**
 * Read the cues for one embedded track, on first use.
 *
 * Deferred rather than done at load time because it walks the media — the only
 * expensive thing here — and a film with three subtitle tracks should not pay for
 * all three when one is chosen.
 *
 * @param {object} track
 */
async function ensureSegments(track) {
  if (track.segments) return track.segments;
  if (track.kind !== 'text') return [];

  const { cues, truncated } = await readMatroska({
    ...readerFor(videoFile),
    trackNumbers: [track.trackNumber],
  });

  track.segments = cues.get(track.trackNumber) ?? [];
  if (truncated) {
    // A cluster too large to hold, or a region that could not be read. Reported
    // rather than passed off as a complete transcript — a partial transcript that
    // looks complete is worse than a named gap.
    track.error = 'some of this track could not be read';
  }
  if (!track.segments.length && !track.error) {
    track.error = 'that track has no cues in it';
  }
  return track.segments;
}

/** Mirror the chosen files into the bar, so the page says what it is holding. */
function render() {
  const names = [videoFile?.name, ...tracks.map((track) => track.name)].filter(Boolean);
  els.chosen.textContent = names.length ? names.join(' · ') : 'No files chosen';
  els.chosen.title = els.chosen.textContent;
}

// --- Captions ----------------------------------------------------------------

/** The cue playing now, or -1 between cues. */
function activeIndex() {
  if (!segments.length) return -1;
  return findActiveIndex(segments, els.video.currentTime);
}

/**
 * Draw the current cue into BOTH placements.
 *
 * Both are written together so switching placement never shows a stale line — a
 * switch that revealed the last cue from ten minutes ago would look like a bug in
 * the video. Only one is visible at a time; the other is `hidden`.
 *
 * The tokens are rendered by `renderReading` from `common/marks.js` — the SAME
 * function the panel uses, so a word looks the same here as in the transcript and
 * the caption text cannot drift from it. Duplicating the rendering would have been
 * the obvious shortcut and is exactly the drift this shares instead.
 *
 * @param {number} index
 */
function renderCaptions(index) {
  const cue = index >= 0 ? segments[index] : null;
  const levelCount = listLevelCount();

  for (const element of [els.overlayPrimary, els.belowPrimary]) {
    element.replaceChildren();
    if (!cue) continue;
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
 * Built here rather than asked of the worker: the reader holds the whole dictionary
 * already, and a message per hover would be a round trip for data this page can read
 * directly. The SHAPE is the one `showEntry` expects, so the popover code does not
 * know which surface it is drawing for — the panel supplies the same shape from a
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
    // One badge, for the single list a reader grades against. The panel shows every
    // list's opinion because the learner is choosing between them; the reader has
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
 * two surfaces cannot disagree about what a file contains — and so a track chosen in
 * one is honoured by the other, since both write the same setting.
 *
 * "Off" on the second line is a real preference, not the absence of one: one line is
 * the ordinary way to watch, and two lines is the study mode.
 */
function renderTrackChoosers() {
  const studySelect = document.getElementById('study-track');
  const glossSelect = document.getElementById('gloss-track');
  if (!studySelect || !glossSelect) return;

  const signature =
    tracks.map((track) => `${track.languageCode}:${track.name ?? ''}`).join(',') +
    `|${settings.studyLanguage ?? ''}|${settings.glossLanguage ?? ''}`;
  if (studySelect.dataset.signature === signature) return;
  studySelect.dataset.signature = signature;
  glossSelect.dataset.signature = signature;

  for (const [select, chosen, includeOff] of [
    [studySelect, settings.studyLanguage, false],
    [glossSelect, settings.glossLanguage, true],
  ]) {
    select.replaceChildren();
    select.disabled = tracks.length === 0;
    if (!tracks.length) {
      select.append(new Option('—', ''));
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
 * the control the user is using — the same guard the panel's selects carry.
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
      listSelect.append(new Option('—', ''));
      listSelect.disabled = true;
    } else {
      listSelect.disabled = false;
      // "Match the track" is a real option, not the absence of one: a learner who
      // has not chosen should see that the reader is choosing for them, rather than
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
      thresholdSelect.append(new Option('—', ''));
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
 * The list the reader grades against.
 *
 * An explicit choice wins; otherwise the list is matched to the track's language, and
 * the BROADEST one for it — a reader with no other information should mark as much as
 * it honestly can. Resolved through the shared `listForLanguage` so the panel and the
 * reader cannot disagree about which list covers a language.
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
  // caption rules read. It was dead markup before — present, styled, and wired to
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
  // was given rather than taking it as an argument — the same arrangement the panel
  // uses, so the reading is drawn identically on both surfaces.
  setReadingSettings({ romaji: settings.romaji, toneStyle: settings.toneStyle });

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
  // left the bar entirely — `relatedTarget` is where it went.
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
// needed reworking: the preview read a synthetic `level` off each cue, while the reader
// marks real tokens — so the level comes off `cue.marked`, which `markSegments` fills
// with the same `markLine` the panel uses. Nothing new is computed; the same marks that
// underline the words decide the colour of the band.
//
// `timecode` already existed further down, for the resume banner. Reused rather than
// redefined: the band and the counter must format a timestamp the same way.

/**
 * Paint the counter, the scrubber position and the played region.
 *
 * Driven from the same tick as the captions rather than from `timeupdate`, so the
 * three never disagree about where playback is — they are one reading of the clock.
 */
function paintTime() {
  const duration = els.video.duration;
  const now = els.video.currentTime;
  els.timeCurrent.textContent = timecode(now);
  els.timeDuration.textContent = Number.isFinite(duration) ? timecode(duration) : '—';

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
 * continuous — which reads as noise and hides the thing it is meant to show.
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

  // A cue carries `start` and `duration`, NOT `end` — the preview this was ported from
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
 * carries the band's name — "Hide band" on its own is a mystery in a bar full of things
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
// released browser** — measured 2026-10-09 on Chrome 148 and Firefox 155. It exists in
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
// helps, and the failure mode is SILENCE — no error, nothing to catch. The selector
// says so instead.

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
 * closed — not immediately, because the element is still reading from it.
 *
 * @type {(() => void)|null}
 */
let releaseStream = null;
/** Whether a rebuild is in flight, so the control can say so rather than appear frozen. */
let audioBusy = false;
/**
 * Whether the track select is showing.
 *
 * Collapsed by default and opened by the waveform button. A select that is always
 * visible is one more control competing for a row that already has the subtitle picks,
 * the list and the threshold — for a preference most viewers set once per film, if at
 * all.
 */
let audioOpen = false;

/**
 * Build the selector from the file's own track list.
 *
 * Hidden when there is no choice, which is the overwhelmingly common case — a control
 * over a single option is noise, and a one-track file has nothing to select.
 */
function renderAudio() {
  const choice = audioTracks.length > 1;
  els.audioButton.hidden = !choice;
  els.audioField.hidden = !choice || !audioOpen;
  els.audioButton.setAttribute('aria-pressed', String(choice && audioOpen));

  if (!choice) {
    els.audioSelect.replaceChildren();
    els.audioNote.textContent = '';
    return;
  }

  els.audioSelect.replaceChildren();
  audioTracks.forEach((track) => {
    const option = document.createElement('option');
    option.value = String(track.index);
    option.textContent = track.label;
    option.selected = track.index === audioChoice;
    els.audioSelect.append(option);
  });

  // The note says only what a viewer could NOT work out by looking. Two cases qualify:
  // a codec this browser cannot play, and a rebuild still running. The old third case
  // — "switching rebuilds a copy of the file" — described the implementation rather
  // than the film, and showed it on every two-track file for as long as the film
  // played. The busy state is already visible in the disabled select, so the only
  // thing left to say out loud is the thing that cannot be fixed by waiting.
  const chosen = audioTracks[audioChoice];
  const unplayable = chosen && !chosen.playable;
  els.audioNote.textContent = unplayable
    ? `This file\u2019s audio (${chosen.codec.toUpperCase()}) is not supported, so it will play silently.`
    : audioBusy
      ? 'Preparing\u2026'
      : '';
  els.audioSelect.disabled = audioBusy;
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
  // Closed for a new file: the panel was opened to answer a question about the PREVIOUS
  // film, and leaving it open would put a stale-looking select in the row.
  audioOpen = false;
  els.audioButton.hidden = true;
  els.audioField.hidden = true;
  try {
    const declared = await listAudioTracks(file);
    // The file may have been replaced while this was reading.
    if (file !== audioSourceFile) return;
    audioTracks = declared;
    renderAudio();
  } catch {
    // An unreadable container is not a failure: it means there is nothing to offer,
    // which is a normal state for a format we do not parse.
  }
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
  // codec it can play — including the ones we cannot decode at any price we would pay.
  //
  // Only usable when the element is actually playing the ORIGINAL file. After a switch
  // the source is a rebuilt stream, and the browser's own track list there is a list of
  // one — so this has to fall through to rebuilding again, or the UI would claim a
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
    // MediaSources are never open against the same element — which throws.
    if (releaseStream) {
      releaseStream();
      releaseStream = null;
    }

    const { url, revoke, done } = await streamTrack(audioSourceFile, index);

    // The element must attach BEFORE production has anywhere to put its output, and
    // `streamTrack` deliberately does not wait for that — see its contract. Swapping
    // `src` is what makes `sourceopen` fire.
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = url;
    releaseStream = revoke;
    els.video.src = url;
    els.video.load();

    // Back to where they were. A new source starts at zero, so without this a viewer
    // who switched mid-film would lose their place.
    els.video.addEventListener(
      'loadedmetadata',
      () => {
        els.video.currentTime = Math.min(resumeAt, els.video.duration || resumeAt);
        if (wasPlaying) void els.video.play().catch(() => {});
      },
      { once: true },
    );

    // Production is awaited, so `audioBusy` covers the whole rebuild rather than only
    // the setup. Releasing it when `streamTrack` returned would allow a second switch
    // while the first stream was still being produced — and the second would revoke the
    // first's URL out from under the element.
    await done;
  } catch (error) {
    setStatus(`Could not switch audio track (${String(error?.message ?? error)}).`, true);
  } finally {
    audioBusy = false;
    renderAudio();
  }
}

els.audioButton.addEventListener('click', () => {
  // Hidden means there is nothing to choose, so activating it must be a no-op.
  if (els.audioButton.hidden) return;
  audioOpen = !audioOpen;
  renderAudio();
  // Focus follows the reveal, so the control is reachable by keyboard without a second
  // tab stop — the button opened something, and what it opened should take focus.
  if (audioOpen) els.audioSelect.focus();
});

els.audioSelect.addEventListener('change', (event) => {
  void selectAudioTrack(Number(event.target.value));
});

// --- Volume ------------------------------------------------------------------
//
// The one control here a generic player ALSO has, so the only thing worth deciding is
// that the slider and the button compose.
//
// NOT a setting. The element keeps its volume across a file change, and the OS volume
// is the real preference — a second one stored here would fight it. That is why this
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
  els.video.volume = volumeScale(Number(els.volumeSlider.value));
  els.video.muted = Number(els.volumeSlider.value) === 0;

  const muted = els.video.muted;
  // The icon is swapped by CSS from this same `aria-pressed`, not from JS: `<g hidden>`
  // does not work, because SVG ignores the HTML attribute.
  const label = muted ? 'Unmute' : 'Mute';
  els.muteButton.setAttribute('aria-pressed', String(muted));
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

function onTimeUpdate() {
  reportPosition();
  const index = activeIndex();
  if (index !== lastRendered) {
    lastRendered = index;
    renderCaptions(index);
  }
  paintTime();
  remember();
}

for (const event of ['timeupdate', 'play', 'pause', 'ended']) {
  els.video.addEventListener(event, onTimeUpdate);
}
// `seeked`, not `seeking`: reported once the new position is real.
els.video.addEventListener('seeked', () => {
  reportPosition(true);
  renderCaptions(activeIndex());
});

// --- The resume position -----------------------------------------------------
//
// Only the POSITION is remembered, never the file: the web platform does not expose
// a path (verified — `file.name` is a basename), and storing the bytes copies them
// (measured — a 256MB file measured 256MB on disk, and the same File twice measured
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

/** Offer to resume, if a position was stored for this file. */
function offerResume() {
  if (!videoFile) return;
  const saved = positions[videoIdFor(videoFile)];
  if (typeof saved !== 'number' || !Number.isFinite(saved)) return;
  // Under two seconds is the start, not a position worth offering. And a position
  // in the last few seconds means the film finished, so resuming there would drop
  // you at the end.
  const duration = els.video.duration;
  if (saved <= 2) return;
  if (Number.isFinite(duration) && saved > duration - 5) return;

  els.resumeText.textContent = `Resume at ${timecode(saved)}?`;
  els.resume.hidden = false;
  els.resume.dataset.seconds = String(saved);
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
  if (button.id === 'resume-go') els.video.currentTime = Number(els.resume.dataset.seconds);
  els.resume.hidden = true;
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
    // The port closed while we were working — the worker restarted, or the panel
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
 * `PROVIDE { languageCode: null }` — and a reader that answered "no such track"
 * produced no transcript for any file, ever, no matter how many tracks were found.
 *
 * The preference order is deliberate:
 *
 *   1. **A track in a language this extension can mark** — Chinese or Japanese,
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

  // `zh` and `ja` are `src/learn/data/index.json`'s languages — the ones with a word
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
  // is a genuine miss — the worker holds a stale choice — and silently substituting
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
  // The language reported back is the TRACK's, not the one requested — the worker
  // adopts it as `studyLang`, and adopting the request (`null`) would leave the
  // choice unset so every later refresh fell back again.
  const code = track?.languageCode ?? languageCode;

  if (!track) {
    return { languageCode: code, translateTo: null, segments: [], error: errorText('READER005') };
  }
  if (!track.segments) {
    return {
      languageCode: code,
      translateTo: null,
      segments: [],
      error: errorText('READER002', track.error ?? 'that track has not been read'),
    };
  }
  if (!track.segments.length) {
    return {
      languageCode: code,
      translateTo: null,
      segments: [],
      error: track.error ?? errorText('READER002', 'no cues in that file'),
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
        // Reading a film's cues takes real time — it walks the media — so the reply
        // is deferred. This is the one genuinely slow request in the reader, and why
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
      // The worker chose this track, so the list and dictionary follow it — the same
      // path the reader's own default-track load takes.
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
 * Cue stepping — the control a generic player cannot have.
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
  // An empty value means "choose for me", which is `null` — a real choice rather than
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

click('pip', () => {
  if (document.pictureInPictureElement) void document.exitPictureInPicture();
  else void els.video.requestPictureInPicture().catch(() => {});
});

// Fullscreen the PICTURE, not the video. This is what lets the bar be a sibling of
// the fullscreened element; `video.requestFullscreen()` takes the media element alone
// and only that element and its descendants are rendered, so no overlay bar could
// ever appear over it.
click('fullscreen', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void els.picture.requestFullscreen().catch(() => {});
});

document.addEventListener('fullscreenchange', () => {
  showBar();
  measureBar();
  scheduleHide();
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
  // toggle playback — pressing a button and pausing the film underneath it is the
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

// Announce. This is how the worker learns which tab is a source — it cannot discover
// the page by URL, because our own pages have no readable `tab.url`.
//
// Retried once, later, because the FIRST attempt can legitimately fail: the service
// worker may be starting up, and on an extension reload this page can outlive the
// worker that would receive it. A single failed announcement leaves the panel
// reporting "no supported video" while this page plays perfectly, so one retry is
// worth it — and the worker looks for open reader tabs itself, so even a lost
// announcement is recoverable.
function announce(attempt = 0) {
  api.runtime.sendMessage({ type: MSG.READER_READY, target: TARGET.BACKGROUND }).catch(() => {
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
  offerResume();
});

// Hover a caption word for its definition, with the same popover the panel draws.
//
// Attached to BOTH placements, because only one is visible at a time and the handler
// is delegated — one listener per container rather than one per token, which for a
// film's captions would be thousands.
//
// The overlay is `pointer-events: none` so it cannot swallow clicks meant for the
// picture, which also means it cannot RECEIVE hover — hence the listener on the
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
render();
setStatus('Ready.');

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
