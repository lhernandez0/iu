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
 * and it reports CONTENT_POSITION as playback advances.
 *
 * The service worker does not know this page exists. It finds it because the page
 * announces itself (`READER_READY`), because `tab.url` is empty for a
 * `chrome-extension://` document without the `tabs` permission — which this
 * extension deliberately does not request. Everything else is the ordinary
 * content contract, which is why the panel, the row model, the marking and the
 * alignment need no changes at all to read a file instead of a website.
 *
 * A MODULE rather than a classic script, unlike the content scripts. Those are
 * injected into a page that does not trust us and cannot `import`; this is our own
 * document, so it can import `subtitles.js` and read the canonical message names
 * from `messages.js` instead of duplicating them. That removes the whole class of
 * drift the content script's "keep in step" comment warns about.
 */

import { MSG, TARGET } from '../common/messages.js';
import { errorText } from '../common/errors.js';
import { findActiveIndex } from '../common/transcript.js';
import { parseSubtitles, languageFromFileName, SUBTITLE_EXTENSIONS } from './subtitles.js';
import { readMatroskaTracks, readMatroska, imageCodecName } from './matroska.js';

/**
 * The extension API namespace — `browser` where it exists (Chrome 148+ and always
 * in Firefox), `chrome` otherwise. Read here rather than imported so it reads the
 * global where it is used; a module would snapshot it at import time and the test
 * stubs reassign the global.
 */
const api = globalThis.browser ?? globalThis.chrome;

const els = {
  video: /** @type {HTMLVideoElement} */ (document.getElementById('video')),
  stage: /** @type {HTMLElement} */ (document.querySelector('.stage')),
  pickFiles: /** @type {HTMLInputElement} */ (document.getElementById('pick-files')),
  pickLabel: /** @type {HTMLElement} */ (document.getElementById('pick-label')),
  chosen: /** @type {HTMLElement} */ (document.getElementById('chosen')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  placeholder: /** @type {HTMLElement} */ (document.getElementById('placeholder')),
};

// --- State ------------------------------------------------------------------

/**
 * The current video file, if one has been chosen.
 *
 * Held so `DESCRIBE` can rebuild the descriptor without re-reading anything, and
 * so a second subtitle file added later does not lose the video.
 *
 * @type {File|null}
 */
let videoFile = null;

/**
 * The blob URL for `videoFile`, kept so it can be revoked.
 *
 * **Leaking these is a real leak, not a theoretical one.** A blob URL pins its
 * backing file until it is revoked, so picking a 4GB film and then picking
 * another one holds both in memory until the tab closes. Every replacement
 * revokes the previous URL.
 *
 * @type {string|null}
 */
let videoObjectUrl = null;

/**
 * Every subtitle track available, in the order they were found.
 *
 * Two sources feed this list and the entries differ only in how their cues are
 * produced, which is what makes an embedded track and a sidecar look identical to
 * everything downstream:
 *
 *   - a SIDECAR file, parsed at pick time (cheap — it is a text file)
 *   - a track INSIDE the video, extracted lazily on first request (not cheap — it
 *     walks the media, so a film's cues are read when a language is chosen, not
 *     when the file is opened)
 *
 * @type {Array<{
 *   languageCode: string,
 *   name: string,
 *   source: 'file'|'embedded',
 *   trackNumber?: number,
 *   segments: object[]|null,
 *   error: string|null,
 *   format?: string,
 *   encoding?: string,
 * }>}
 */
let tracks = [];

/** @type {object[]} */
let segments = [];

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
  // A code in the text is also published as a data attribute, so the panel's
  // existing affordance for copying an error code works here too.
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

/** A stable identity for a file, for the worker's cache key. */
function videoIdFor(file) {
  // Name, size and modification time together. Deliberately NOT the blob URL:
  // that changes on every pick, so the cache would miss every time and the
  // worker's tracked-video set would grow without bound.
  return `local:${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * A bounded `read(offset, length)` over a `File`, for the Matroska parser.
 *
 * `File.slice()` does not read anything — it is a view — and the `blob.arrayBuffer()`
 * it returns reads only that slice. So a multi-gigabyte film costs us one window
 * at a time and never the whole file.
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
 * `trackList` entries are what the panel's language dropdowns render, so its
 * shape is the contract — not a presentation choice.
 */
function describeVideo() {
  if (!videoFile) {
    return { videoId: '', title: '', isLive: false, trackList: [], translationLanguages: [] };
  }
  return {
    videoId: videoIdFor(videoFile),
    title: videoFile.name,
    isLive: false,
    // One entry per subtitle track found, from the video's own container or from
    // a sidecar file. A track that cannot be read still appears, because a language
    // that is present but unusable is worth showing with its reason attached
    // rather than vanishing silently.
    //
    // `languageCode` is what the panel's dropdowns select on, so a duplicate
    // language is disambiguated at discovery (`ja (2)`) rather than here — the
    // panel must never receive two entries it cannot tell apart.
    trackList: tracks.map((track) => ({
      languageCode: track.languageCode,
      name: track.name || track.languageCode,
      // `translatable: false` for every local track. The panel reads this to
      // disable its machine-translation checkboxes: translating a local file
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
    setStatus(`${errorText('READER002', 'no video or subtitle file in that selection')}`, true);
    return;
  }
  render();

  // Tell the worker there is something to read now. This is what makes the reader
  // work when the side panel was ALREADY open: `READER_READY` fired once, on an
  // empty page, so without this the worker never learned that a file had been
  // chosen and the panel stayed blank while the film played.
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
 * playback is started first and the track list fills in after.
 *
 * @param {File} file
 */
async function loadVideo(file) {
  // Revoke the previous URL before replacing it, or its file stays pinned.
  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);

  videoFile = file;
  videoObjectUrl = URL.createObjectURL(file);
  els.video.src = videoObjectUrl;
  els.placeholder.hidden = true;

  // A file the browser cannot decode is the one failure it will not tell us about
  // in advance. `canPlayType` is useless here — it answers about the CONTAINER,
  // not the codecs inside, and returns empty even for files Chrome then plays. So
  // the only honest detection is the error event, after trying. This is also the
  // limit of the MKV support: the CONTAINER is readable by us, but whether its
  // video DECODES is the browser's business, and for HEVC it often will not.
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

  // A video dropped without a `.mkv` extension is still worth trying to read —
  // the container, not the filename, decides whether there are tracks in it.
  try {
    await loadEmbeddedTracks(file);
  } catch (error) {
    // A container we cannot parse is not a reason to refuse the video. It means
    // there are no embedded tracks we can offer, which is a normal state — the
    // user can still pick a sidecar file.
    setStatus(`Could not read subtitle tracks from this video (${String(error?.message ?? error)}). Use a .srt file.`, true);
  }
}

/** @param {File[]} files */
async function loadSubtitles(files) {
  for (const file of files) {
    // Read as bytes, not text, so `subtitles.js` can detect the encoding rather
    // than compounding a guess about it with a default.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { segments: cues, format, encoding, error } = parseSubtitles(bytes, file.name);

    const languageCode = languageFromFileName(file.name);

    // Replace a track for the same language rather than listing both, so picking
    // a corrected version of the same file does not leave the old one behind.
    tracks = tracks.filter((track) => !(track.source === 'file' && track.languageCode === languageCode));
    tracks.push({
      languageCode,
      name: file.name,
      source: 'file',
      segments: cues,
      error,
      format,
      encoding,
    });
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
 * Cheap: this reads only the `Tracks` element, which precedes the media, so a
 * film's subtitle list arrives without its clusters being touched. That is what
 * lets the panel offer "Japanese / English / Chinese" the moment a file is opened
 * rather than after reading two gigabytes.
 *
 * It is also where an IMAGE track is recognised — Blu-ray PGS and DVD VobSub are
 * pictures of text, so they are listed with an error attached rather than being
 * offered as a language that will produce an empty transcript.
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
    // two Japanese tracks (one full, one signs-only) is a real shape, and hiding
    // the second would make the chosen one unchangeable.
    let unique = code;
    for (let n = 2; usedCodes.has(unique) || embedded.some((t) => t.languageCode === unique); n++) {
      unique = `${code} (${n})`;
    }
    usedCodes.add(unique);

    embedded.push({
      languageCode: unique,
      // The muxer's own title when it has one, which is often the most useful
      // label on the track (`Signs & Songs`, `English (SDH)`).
      name: track.name ?? null,
      source: 'embedded',
      trackNumber: track.number,
      codec: track.codec,
      kind: track.kind,
      // Known now for an image track, which needs no reading to refuse.
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

  const readable = tracks.filter((track) => track.kind !== 'image' && track.segments !== null);
  setStatus(`${tracks.length} subtitle track${tracks.length === 1 ? '' : 's'} in this video`);
  void readable;
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
}

// --- Position reporting -----------------------------------------------------

/**
 * Tell the worker which cue is playing.
 *
 * `timeupdate` fires about four times a second, which is plenty: rows are per
 * cue, not per frame, and the YouTube path polls a 250ms timer for the same
 * reason. `requestAnimationFrame` here would post roughly 240x more messages to
 * move a highlight that changes a few times a minute.
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

for (const event of ['timeupdate', 'play', 'pause', 'ended']) {
  els.video.addEventListener(event, () => reportPosition());
}
// `seeked`, not `seeking`: reported once the new position is real.
els.video.addEventListener('seeked', () => reportPosition(true));

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
 * produced no transcript for any file, ever, no matter how many subtitle tracks
 * were found. The YouTube content script has always done this: its PROVIDE ends
 * `wanted ?? pickDefaultTrack(...)`.
 *
 * The preference order is deliberate rather than "whichever is first":
 *
 *   1. **A track in a language this extension can actually mark** — Chinese or
 *      Japanese, because marking is the whole point and a film with both Chinese
 *      and English subtitles should open on the Chinese ones.
 *   2. **Any readable text track**, so a French film still opens with its French
 *      subtitles, unmarked and correct, rather than empty.
 *   3. **Null**, meaning there is genuinely nothing to show.
 *
 * @returns {object|null}
 */
function pickDefaultTrack() {
  const usable = tracks.filter((track) => track.kind !== 'image' && !(track.segments === null && track.error));
  if (!usable.length) return null;

  // `zh` and `ja` are `src/learn/data/index.json`'s languages — the ones with a
  // word list, and therefore the only ones that mark anything.
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
  // Only fall back when nothing was ASKED for. A named language that does not
  // exist is a genuine miss — the worker holds a stale choice — and silently
  // substituting another language would put a different language's text under a
  // heading that says otherwise.
  if (languageCode) return { track: null, fellBack: false };
  return { track: pickDefaultTrack(), fellBack: true };
}

/**
 * The `fetched` shape the worker expects from PROVIDE / FETCH_TRACK.
 *
 * Takes a RESOLVED track rather than a language code, because resolving is where
 * the default is chosen and doing it inside here would mean every caller had to
 * remember to ask for the fallback. See `resolveTrack`.
 *
 * The error goes INSIDE `fetched.error` rather than as a top-level failure,
 * because the worker reads it to tell a failed translation from a failed fetch
 * and takes a different branch for each. A top-level `ok: false` would take the
 * wrong one.
 *
 * @param {object|null} track
 * @param {string} languageCode What the worker asked for, for the reply's field.
 * @param {boolean} fellBack Whether the track was chosen rather than requested.
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
    // Expected only when the caller should have resolved the cues first. Reported
    // rather than returned as an empty success, which would look like a track with
    // no lines in it.
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
      // `resolveTrack`, not `trackFor`. The FIRST request for any video names no
      // language at all — `settings.studyLanguage` defaults to null — so a reader
      // that only answered named languages produced no transcript for any file.
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
        // Reading a film's cues takes real time — it walks the media — so the
        // reply is deferred. This is the one genuinely slow request in the
        // reader, and why the worker gives these two messages the long timeout.
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
      // position reporting has something to measure against — without it a
      // cached video reports no cue at all and the panel never scrolls.
      segments = Array.isArray(message.segments) ? message.segments : [];
      activeTrackLanguage = message.languageCode ?? activeTrackLanguage;
      // Force the next report: the previous cue belonged to whatever was loaded
      // before, and suppressing the first report would leave the panel waiting
      // for a change that may never come on a paused video.
      lastIndex = -2;
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

// --- Wiring -----------------------------------------------------------------

els.pickFiles.addEventListener('change', () => {
  void acceptFiles(els.pickFiles.files ?? []);
  // Reset so choosing the same file twice fires `change` again. Without this,
  // re-picking a corrected subtitle file is silently ignored.
  els.pickFiles.value = '';
});

// Drag and drop, because it is what people try first. The buttons stay as the
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

// The blob URL is scoped to this document, so a reload loses the file. Revoke on
// the way out rather than leaving the browser to clean up an orphan.
window.addEventListener('pagehide', () => {
  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
});

// Announce. This is how the worker learns which tab is a source — it cannot
// discover the page by URL, because our own pages have no readable `tab.url`.
//
// Retried once, later, because the FIRST attempt can legitimately fail: the
// service worker may be starting up, and on an extension reload this page can
// outlive the worker that would receive it. A single failed announcement leaves
// the panel reporting "no supported video" while this page plays perfectly, so one
// retry is worth it — and the worker looks for open reader tabs itself, so even a
// lost announcement is recoverable.
function announce(attempt = 0) {
  api.runtime.sendMessage({ type: MSG.READER_READY, target: TARGET.BACKGROUND }).catch(() => {
    if (attempt === 0) {
      setTimeout(() => announce(1), 500);
    } else {
      setStatus('Reopen this page from the toolbar menu.', true);
    }
  });
}

announce();

render();
setStatus('Ready.');
