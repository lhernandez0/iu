/**
 * The video-reader player mock.
 *
 * Plays a REAL file and exercises the decided behaviour for real, the bar's single
 * lifecycle, the error pinning, both caption placements, the resume prompt. A mock
 * whose buttons do nothing is a picture; this is the behaviour, so a layout that
 * only LOOKS right can be caught by using it.
 *
 * Nothing here is imported by the extension. It is a preview, like
 * `tools/ui/reading.mjs`, and deliberately not a copy of `reader.js`: that file
 * carries the content-message contract, the Matroska reading and the track
 * resolution, none of which is on trial. What IS on trial is the bar and the
 * captions, and both are small.
 *
 * It follows the same rule as the extension's settings registry: state is read once
 * from storage and written through one function, so nothing here can drift from
 * what the real reader would do with the same value.
 *
 * ## Where the video comes from
 *
 * `tools/ui/assets/preview.mp4`, a STREAM COPY (not a re-encode) of
 * `test/conformance/test5.mkv`, CELLAR's subtitle test file. The film is **Elephants
 * Dream** (Blender Foundation / Netherlands Media Art Institute, CC BY 2.5). Built by
 * `make-preview-video.mjs`, which also extracts the file's own subtitle track for the
 * captions.
 *
 * **The film is Elephants Dream even though the file's own `TITLE` tag says `Big Buck
 * Bunny - test 8`.** That tag is wrong on this particular master, and reading it as
 * fact is how the preview shipped claiming the wrong film under the wrong licence. The
 * evidence that settles it is in the sample's OWN SUBTITLES: they name **Proog** and
 * **Emo**, the two characters of Elephants Dream. Nothing in Big Buck Bunny says
 * either name. The picture agrees, this file is dark, warm and saturated
 * (`mean_rgb=(120,80,36)`, saturation 70%), where the actual Big Buck Bunny files
 * (test1, test6) are bright and near-desaturated (`(180,179,161)`, 10%).
 *
 * A metadata field is a claim, not a fact. This is the same mistake as the filename
 * label below, one file further in.
 *
 * The remux exists because **the VS Code integrated browser cannot play the
 * Matroska container at all**, measured: H.264 in MP4 plays, H.264 in MKV does not,
 * and neither does VP9 in MKV. It is the container, not the codec, and
 * `canPlayType` says "probably" throughout, which makes the wrong diagnosis
 * convincing. **Check MKV in real Chrome.**
 */

import { levelColour } from '/src/learn/wordlist.js';

const params = new URLSearchParams(location.search);
const SOURCE = params.get('src') ?? '/tools/ui/assets/preview.mp4';

/**
 * The file the user picked, if they have picked one.
 *
 * The bar shows this or, failing that, `SOURCE`, never a typed-in string. The label
 * WAS a literal `Big Buck Bunny, test5.mkv` in the markup, which was wrong three
 * times over: it kept claiming that after another file was opened, it was not the name
 * of the file being loaded, and it named the wrong FILM. A label that is written
 * rather than derived goes stale without anyone noticing, which is exactly what
 * happened.
 *
 * @type {File|null}
 */
let pickedFile = null;

/**
 * CC BY attribution for the bundled sample, shown as the label's `title`.
 *
 * Required by the licence rather than decorative, and set in SCRIPT so it applies to
 * the sample alone. A picked file gets its own name and no attribution, because we
 * have no idea what it is.
 *
 * **Elephants Dream, and CC BY 2.5**, not Big Buck Bunny and 3.0. `THIRD-PARTY.md`
 * had this right. The file's `TITLE` tag says Big Buck Bunny and is wrong; the
 * subtitles name Proog and Emo, who exist only in Elephants Dream. The licence turns
 * on this: CC BY 2.5 and 3.0 are different instruments, so naming the wrong one in an
 * attribution is a licence defect, not a typo.
 */
const SAMPLE_TITLE =
  'Elephants Dream (c) copyright 2006, Blender Foundation / Netherlands Media Art ' +
  'Institute / www.elephantsdream.org, CC BY 2.5, remuxed from the CELLAR suite\u2019s test5.mkv';

/**
 * The file's own subtitle track, extracted by `make-preview-video.mjs`.
 *
 * Overridable so a different sample can bring its own cues: `?srt=/path/to.srt`.
 * Without one the cue list falls back to placeholders AND SAYS SO, a subtitle
 * feature mocked with invented subtitles is not a test of anything.
 */
const SRT_URL = params.get('srt') ?? '/tools/ui/assets/preview.en.srt';

/**
 * The blob URL currently playing, when the user opened their own file.
 *
 * Kept so it can be revoked: a blob URL pins its backing file until revoked, so
 * replacing the source without revoking holds every file opened this session in
 * memory. The reader already documents this; a mock that leaked while demonstrating
 * a player would be a poor advertisement.
 *
 * @type {string|null}
 */
let objectUrl = null;

const els = {
  video: document.getElementById('pp-video'),
  stage: document.getElementById('pp-stage'),
  picture: document.getElementById('pp-picture'),
  placeholder: document.getElementById('pp-placeholder'),
  placeholderError: document.getElementById('pp-placeholder-error'),
  bar: document.getElementById('pp-bar'),
  status: document.getElementById('pp-status'),
  note: document.getElementById('pp-note'),
  resume: document.getElementById('pp-resume'),
  resumeText: document.getElementById('pp-resume-text'),
  captionRow: document.getElementById('pp-caption-row'),
  overlay: document.getElementById('pp-captions-overlay'),
  below: document.getElementById('pp-captions-below'),
  overlayPrimary: document.getElementById('pp-caption-primary'),
  overlaySecondary: document.getElementById('pp-caption-secondary'),
  belowPrimary: document.getElementById('pp-caption-primary-below'),
  belowSecondary: document.getElementById('pp-caption-secondary-below'),
  scrubber: /** @type {HTMLInputElement} */ (document.getElementById('pp-scrubber')),
  cues: document.getElementById('pp-cues'),
  timeCurrent: document.getElementById('pp-time-current'),
  timeDuration: document.getElementById('pp-time-duration'),
  audioButton: document.getElementById('pp-audio'),
  audioPanel: document.getElementById('pp-audio-panel'),
  audioSelect: /** @type {HTMLSelectElement} */ (document.getElementById('pp-audio-track')),
  audioNote: document.getElementById('pp-audio-note'),
  audioBadge: document.querySelector('#pp-audio .pp-audio-badge'),
  muteButton: document.getElementById('pp-mute'),
  volumeSlider: /** @type {HTMLInputElement} */ (document.getElementById('pp-volume')),
  filename: /** @type {HTMLElement} */ (document.getElementById('pp-filename')),
};

// --- Settings ----------------------------------------------------------------
//
// Mirrors the extension's registry: the same ids, the same defaults, the same
// coercion. The real reader reads these from `chrome.storage` and writes them the
// same way; here they go to `localStorage` because a preview has no extension
// storage. The SHAPE is what matters, one object, one write function, defaults in
// one place.

const SETTINGS_KEY = 'iu-preview-settings';

const DEFAULTS = {
  captionsOn: true,
  captionPlacement: 'overlay',
  romaji: 'above',
  markStyle: 'underline',
  captionSize: 20,
  defaultSpeed: '1',
  // Whether the difficulty band is drawn under the scrubber. On by default, because
  // it is the one piece of information a generic player cannot show, but a toggle,
  // because a learner who is watching rather than studying may want a clean bar.
  difficulty: true,
  // Volume is remembered per preview, not per file. Persisting it is the point:
  // re-picking a file after a page reload is a normal way to use the reader, and
  // having to reset the volume every time would be a bug in the eyes of a user.
  //
  // NOT a `volume` setting for the extension. It exists here because a preview needs
  // to be usable across reloads; a real player should follow the OS volume, which is
  // what Firefox's `media.volume_scale` default of 1.0 already does.
  volume: 100,
};

const PLACEMENTS = ['overlay', 'below'];
const READINGS = ['off', 'above', 'below', 'marked'];
const MARK_STYLES = ['underline', 'highlight'];
const SPEEDS = ['0.5', '0.75', '1', '1.25'];

/**
 * The settings in force.
 *
 * Read once at load and written through `saveSettings`, exactly as the extension
 * does, the alternative is reading storage in a render and writing it in a
 * listener, which is how two places come to disagree.
 */
let settings = { ...DEFAULTS };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    // Coerced, not trusted: a value from an older version or a hand-edited entry
    // must degrade to something renderable rather than produce a blank screen. The
    // extension does the same in `settings.js`.
    if (typeof stored.captionsOn === 'boolean') settings.captionsOn = stored.captionsOn;
    if (PLACEMENTS.includes(stored.captionPlacement)) settings.captionPlacement = stored.captionPlacement;
    if (READINGS.includes(stored.romaji)) settings.romaji = stored.romaji;
    if (MARK_STYLES.includes(stored.markStyle)) settings.markStyle = stored.markStyle;
    if (SPEEDS.includes(String(stored.defaultSpeed))) settings.defaultSpeed = String(stored.defaultSpeed);
    if (typeof stored.difficulty === 'boolean') settings.difficulty = stored.difficulty;
    const volume = Number(stored.volume);
    if (Number.isFinite(volume)) settings.volume = Math.min(100, Math.max(0, volume));
    const size = Number(stored.captionSize);
    if (Number.isFinite(size)) settings.captionSize = Math.min(34, Math.max(12, size));
  } catch {
    // A corrupt entry is not worth a failure; the defaults are already in place.
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode, or storage disabled. Losing a preference is not worth a
    // failure.
  }
}

// --- The cue list ------------------------------------------------------------
//
// The reader gets its cues from the worker, which is not running in a preview, so
// the mock fetches the file's OWN subtitle track. Real text, real timing.

/** @type {Array<{start: number, end: number, text: string}>} */
let cues = [];
/** Whether the cues came from the real subtitle track. */
let cuesAreReal = false;

/**
 * Parse SubRip.
 *
 * Deliberately minimal, enough for the file this reads, not a general parser. The
 * reader's real parsing lives in `src/viewer/subtitles.js` and is tested there;
 * duplicating it would be a second implementation to keep in step.
 *
 * @param {string} text
 */
function parseSrt(text) {
  const out = [];
  for (const block of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length < 2) continue;
    const timing = lines.find((line) => line.includes('-->'));
    if (!timing) continue;
    const [from, to] = timing.split('-->').map((part) => part.trim());
    const start = srtTime(from);
    const end = srtTime(to);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ start, end, text: lines.slice(lines.indexOf(timing) + 1).join(' ').trim() });
  }
  return out;
}

/** `00:00:03,549` → seconds. @param {string} value */
function srtTime(value) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value);
  if (!match) return NaN;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

/** Evenly-spaced stand-ins, used only when the real track is unavailable. */
function placeholderCues(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const out = [];
  for (let start = 0; start + 0.2 < duration; start += 4) {
    out.push({
      start,
      end: Math.min(start + 4, duration),
      text: `placeholder line ${out.length + 1}, no subtitle track loaded`,
    });
  }
  return out;
}

/** @param {number} seconds */
function activeCueIndex(seconds) {
  return cues.findIndex((cue) => seconds >= cue.start && seconds < cue.end);
}

// --- The resume prompt -------------------------------------------------------
//
// Keyed on the path here, where the reader keys on
// `local:<name>:<size>:<lastModified>`. The identity scheme is the extension's
// business and is already implemented; what is being looked at is the PROMPT, the
// position cannot reopen the file, so the offer is the feature.

const POSITION_KEY = `iu-preview-position:${SOURCE}`;

/** @param {number} seconds */
function remember(seconds) {
  try {
    localStorage.setItem(POSITION_KEY, String(seconds));
  } catch {
    // Not worth a failure.
  }
}

function recall() {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
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

/**
 * Offer to resume, if a position was stored.
 *
 * The banner rather than a silent seek: the file cannot be reopened on its own, so
 * the user re-picks it, and a jump with no explanation is disorienting.
 */
function offerResume() {
  const saved = recall();
  if (saved === null || !Number.isFinite(saved)) return;
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

// --- Position reporting ------------------------------------------------------
//
// 250ms is what the YouTube path polls and what `timeupdate` amounts to. Rows are
// per cue, not per frame, so a per-frame tick would post ~240x more messages to
// move a highlight that changes a few times a minute.

let lastWrite = 0;
let lastCueIndex = -2;

function tick() {
  const index = activeCueIndex(els.video.currentTime);
  paintTime();

  if (index !== lastCueIndex) {
    lastCueIndex = index;
    renderCaptions(index);
    // The status line tracks whether there is a cue at all, NOT which cue, the
    // cue text belongs to the captions and nowhere else.
    if (!statusPinned()) {
      els.status.textContent = cues.length
        ? index >= 0
          ? `Line ${index + 1} of ${cues.length}`
          : `Between lines · ${cues.length} in this file`
        : 'No subtitle track';
    }
  }

  const now = performance.now();
  if (now - lastWrite > 5000) {
    lastWrite = now;
    remember(els.video.currentTime);
  }

  requestAnimationFrame(tick);
}

// --- Captions ----------------------------------------------------------------

/**
 * Draw the cue into the visible caption placement.
 *
 * Both placements are kept in the DOM and their text is written together, so
 * switching placement never shows a stale line, a placement switch that revealed
 * the last cue from ten minutes ago would look like a bug in the video.
 *
 * The gloss line is empty on purpose: there is no translation without the worker,
 * and inventing one would be worse than an honest gap, which the CSS collapses.
 * That empty line is the slot the sidebar's second line fills in the real thing.
 *
 * @param {number} index
 */
function renderCaptions(index) {
  const cue = index >= 0 ? cues[index] : null;
  const text = cue?.text ?? '';
  // A SYNTHETIC gloss, so the two-line layout can be seen in the preview. The real
  // reader gets its second line from a second subtitle track; the sample is English
  // with one track, so there is nothing to show without this. Marked as a translation
  // so it is not mistaken for the file's own text.
  const gloss = cue ? `[translation] ${cue.text.split(' ').slice(0, 4).join(' ')}…` : '';
  els.overlayPrimary.textContent = text;
  els.belowPrimary.textContent = text;
  els.overlaySecondary.textContent = gloss;
  els.belowSecondary.textContent = gloss;
}

/** Whether the strip is currently on screen, whichever placement is in force. */
function captionsVisible() {
  return settings.captionsOn;
}

/**
 * Show or hide the caption strip, in the placement the settings name.
 *
 * The row-2 caption settings follow the SAME switch: the row appears when the
 * captions do, because its controls are about the captions and are dead weight
 * when there is nothing on screen for them to change.
 */
function applyCaptions() {
  const on = captionsVisible();
  const below = settings.captionPlacement === 'below';

  els.overlay.hidden = !on || below;
  els.below.hidden = !on || !below;
  els.captionRow.hidden = !on;

  const button = document.getElementById('pp-captions');
  button.setAttribute('aria-pressed', String(on));
  const label = on ? 'Hide captions' : 'Show captions';
  button.setAttribute('aria-label', label);
  button.title = label;

  for (const chip of document.querySelectorAll('[data-placement]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.placement === settings.captionPlacement));
  }

  document.getElementById('pp-reading').value = settings.romaji;
  document.getElementById('pp-marks').value = settings.markStyle;
  document.getElementById('pp-caption-size').value = String(settings.captionSize);
  document.documentElement.style.setProperty('--caption-size', `${settings.captionSize}px`);

  renderCaptions(activeCueIndex(els.video.currentTime));
  // The overlay sits above the bar, so its offset depends on how tall the bar
  // currently is, measured rather than guessed, because the bar grows when the
  // caption row appears.
  measureBar();
}

/** @param {boolean} on */
function setCaptions(on) {
  settings.captionsOn = on;
  saveSettings();
  applyCaptions();
}

/**
 * Reflect the difficulty setting in the button and the band.
 *
 * The label is the ACTION ("Hide difficulty band"), matching the caption toggle, and
 * it carries the band's name, because "Hide band" on its own is a mystery in a control
 * bar full of things that hide.
 */
function applyDifficulty() {
  const on = settings.difficulty;
  const button = document.getElementById('pp-difficulty');
  button.setAttribute('aria-pressed', String(on));
  const label = on ? 'Hide difficulty band' : 'Show difficulty band';
  button.setAttribute('aria-label', label);
  button.title = label;
  paintDifficulty(els.video.duration);
}

/** @param {boolean} on */
function setDifficulty(on) {
  settings.difficulty = on;
  saveSettings();
  applyDifficulty();
}

// --- Volume ------------------------------------------------------------------
//
// Separate from the audio TRACK controls above, and deliberately so. A track is which
// stream you hear; volume is how loud. They also behave differently: a track choice is
// per file, volume is not.
//
// This is the one control here that a generic player ALSO has, so the only thing worth
// designing is where it sits and that it composes with the mute button, see the
// markup for why it is a pair rather than one or the other.

/**
 * The volume a slider position means.
 *
 * The slider is 0-100 for a reason that is not cosmetic: a linear slider runs straight
 * through the part of the range where hearing actually changes. Perceptual loudness is
 * roughly logarithmic, so a linear control spends half its travel on loud-to-louder,
 * where the ear can barely tell the difference, and rushes through the quiet end where
 * it can. The square is the standard cheap correction, the same curve Firefox uses
 * for `media.volume_scale`. It is kept in a named function because a bare `** 2` at a
 * call site is the kind of magic number that gets "cleaned up".
 *
 * @param {number} position 0..100
 */
function volumeScale(position) {
  const fraction = Math.min(1, Math.max(0, position / 100));
  return fraction * fraction;
}

/** The slider position a volume means, the inverse of `volumeScale`. */
function volumePosition(volume) {
  return Math.round(Math.sqrt(Math.min(1, Math.max(0, volume))) * 100);
}

/**
 * Push the stored volume onto the element and into the controls.
 *
 * `muted` is a separate property, so the icon reflects it rather than volume being
 * zero. Dragging the slider to the bottom therefore means "silent", not "muted", and
 * the icon keeps saying which of the two it is.
 */
function applyVolume() {
  els.video.volume = volumeScale(settings.volume);
  els.volumeSlider.value = String(settings.volume);
  els.video.muted = settings.volume === 0;

  const muted = els.video.muted;
  // The icon is swapped by CSS from this same `aria-pressed`, not from JS. See the
  // stylesheet: `<g hidden>` does not work, because SVG ignores the HTML attribute.

  const label = muted ? 'Unmute' : 'Mute';
  els.muteButton.setAttribute('aria-pressed', String(muted));
  els.muteButton.setAttribute('aria-label', label);
  els.muteButton.title = label;
}

/**
 * Mute, remembering the level that was interrupted.
 *
 * The remembered level is what makes the slider usable: without it, unmuting after
 * sliding to zero would leave you silent with the button claiming otherwise, and
 * getting back to where you were would be guesswork. Kept in the element rather than
 * in settings because it is not a preference, it is the state of one interaction.
 *
 * @param {boolean} muted
 */
function setMuted(muted) {
  if (muted) {
    lastVolume = settings.volume > 0 ? settings.volume : lastVolume;
    settings.volume = 0;
  } else {
    settings.volume = lastVolume > 0 ? lastVolume : 100;
  }
  saveSettings();
  applyVolume();
}

/** @param {number} position 0..100 */
function setVolume(position) {
  settings.volume = Math.min(100, Math.max(0, Math.round(position)));
  if (settings.volume > 0) lastVolume = settings.volume;
  saveSettings();
  applyVolume();
}

/** The level to come back to after unmuting. Not persisted: it is one interaction. */
let lastVolume = 100;

// --- Audio tracks ------------------------------------------------------------
//
// ## What this vendored API is, and why the code is shaped around its absence
//
// `HTMLMediaElement.audioTracks` is **not available in any released browser**.
// Measured 2026-10-09: Chrome 148 and Firefox 155 both play a local file with two
// audio tracks, both expose `MediaSource` and `AudioDecoder`, and neither exposes
// `audioTracks`, `videoTracks`, `webkitAudioTracks` or `setAudioTrack`.
//
// The API is **implemented in Blink but flag-gated** behind
// `--enable-blink-features=AudioVideoTracks`. With that flag it works completely:
// it lists the container's tracks in file order with `id`, `label` and `language`,
// and `list[i].enabled = true` switches playback. Verified against both a
// two-audio-track MKV and MP4.
//
// So this is not "impossible", it is "not shipped", and the difference decides the
// shape of the code. Everything is feature-detected, and where the API is absent
// the control explains itself and stays unavailable rather than disappearing. A
// missing button raises "where is it?"; a disabled one with a reason answers it.
// That is also what makes the transition free: the day Chrome unflags this, the
// feature appears in the reader with no code change beyond deleting a note.
//
// ## What the extension will do, when the platform allows
//
// The local-file path only. YouTube is a separate problem: the player has its own
// quality/track API reachable from the MAIN-world `page-bridge.js`, and whether
// those methods survive in the current build is unverified, a different probe and a
// different answer.

/** Whether the audio panel is open. The button toggles it; the setting does not. */
let audioPanelOpen = false;

/** Whether the platform gives us a way to choose between audio tracks. */
function audioTracksSupported() {
  return 'audioTracks' in HTMLMediaElement.prototype;
}

/**
 * A label for one audio track, from whatever the file actually declared.
 *
 * The order of preference is specificity: a `label` the muxer wrote, then the
 * language tag, then the codec, then the position in the file. The last two are the
 * ones that matter, because most Matroska files in the wild carry neither a title
 * nor a language, and a list of four identical "Track" entries is worse than
 * useless. The index is always there, so there is always something to say.
 *
 * @param {{label?: string, language?: string, id?: string}} track
 * @param {number} index
 */
function describeAudioTrack(track, index) {
  const kind = track.label ?? '';
  // `und` is the container saying "undetermined", which is not a label. Showing it
  // would put the word "und" in front of a user as though it were a language.
  const language = track.language && track.language !== 'und' ? track.language : '';
  const name = [kind, language].filter(Boolean).join(' · ');
  return name ? `${index + 1}. ${name}` : `Track ${index + 1}`;
}

/**
 * Build the audio panel from the file's own track list.
 *
 * Offered ONLY when there is a choice to make. A one-track file is the overwhelmingly
 * common case, and a control over a single option is noise, the same reason the row
 * of caption settings appears only while captions are on.
 *
 * Filenames are never used to name a track. `preview.mp4` says nothing
 * about which stream is which; the file's own metadata does, or nothing does.
 */
function renderAudioTracks() {
  const tracks = audioTracksSupported() ? [...els.video.audioTracks] : [];
  const choice = tracks.length > 1;

  els.audioButton.hidden = !choice;
  els.audioPanel.hidden = !choice || !audioPanelOpen;
  if (!choice) {
    els.audioSelect.replaceChildren();
    els.audioBadge.textContent = '';
    return;
  }

  els.audioSelect.replaceChildren();
  tracks.forEach((track, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = describeAudioTrack(track, index);
    option.selected = track.enabled;
    els.audioSelect.append(option);
  });

  els.audioBadge.textContent = String(tracks.length);
  els.audioButton.title = `Audio track (${tracks.length} available)`;
  els.audioNote.textContent = 'Prefer the original audio and read the subtitles.';
}

/**
 * Say why the control cannot be used, in a sentence THE USER CAN REACH.
 *
 * **`aria-disabled`, never `disabled`.** A truly disabled element fires no mouse
 * events, so its `title` never appears and it cannot be focused, which is how such a
 * control ends up with an explanation that exists and is unreachable at the same
 * time. This is the standard "disabled but explainable" pattern: the button stays
 * focusable and clickable, announces itself as unavailable, and opens a panel that
 * says why.
 */
function explainAudioAbsence() {
  els.audioButton.hidden = false;
  els.audioButton.setAttribute('aria-disabled', 'true');
  els.audioButton.setAttribute('aria-expanded', String(audioPanelOpen));
  els.audioButton.title = 'Audio track selection is not available in this browser';
  els.audioBadge.textContent = '';
  els.audioPanel.hidden = !audioPanelOpen;
  if (!audioPanelOpen) return;
  els.audioSelect.replaceChildren();
  els.audioSelect.disabled = true;
  els.audioNote.textContent =
    'This browser does not let a page choose a file’s audio tracks. The feature ' +
    'exists in the engine, gated behind a flag, so this will work when it ships.';
}

/**
 * Reflect the audio setting and open state in the button and panel.
 *
 * Deliberately NOT part of `applyCaptions`: audio tracks and captions are independent
 * choices about the same video, and tying them to one switch would make turning the
 * subtitles off silently change the language you are listening to.
 */
function applyAudio() {
  if (!audioTracksSupported()) {
    explainAudioAbsence();
    return;
  }
  renderAudioTracks();
  els.audioButton.setAttribute('aria-expanded', String(audioPanelOpen));
}

/** @param {number} index */
function selectAudioTrack(index) {
  if (!audioTracksSupported()) return;
  const tracks = [...els.video.audioTracks];
  if (!tracks[index]) return;
  // The API has no "current track" setter: exactly one track is enabled, so the
  // others are cleared. Letting two be true is a state the element cannot play.
  tracks.forEach((track, at) => {
    track.enabled = at === index;
  });
  renderAudioTracks();
}

/**
 * Write the bar's filename from whatever is ACTUALLY loaded.
 *
 * Two sources and no third: a file the user picked, whose base name is all the web
 * platform will give us (`file.name` has no path, verified), or the bundled sample's
 * own file name. Never a literal, see `pickedFile`.
 */
function paintFilename() {
  if (pickedFile) {
    els.filename.textContent = pickedFile.name;
    els.filename.title = '';
    return;
  }
  els.filename.textContent = SOURCE.split('/').pop();
  // The attribution belongs to the bundled sample and to nothing else.
  els.filename.title = SOURCE.includes('preview.') ? SAMPLE_TITLE : SOURCE;
}

// --- The time bar ------------------------------------------------------------
//
// A scrubber, a counter and a cue strip. The cue strip is the part a generic player
// cannot have: it draws WHERE the marked words are, so the hard stretch of a film is
// visible on the timeline before you reach it.

/**
 * Repaint the counter, the scrubber position and the played region.
 *
 * Driven from the same tick as the captions rather than from `timeupdate`, so the
 * three never disagree about where playback is, they are one reading of the clock,
 * not three listeners on it.
 */
function paintTime() {
  const duration = els.video.duration;
  const now = els.video.currentTime;
  els.timeCurrent.textContent = timecode(now);
  els.timeDuration.textContent = Number.isFinite(duration) ? timecode(duration) : '-';

  if (!Number.isFinite(duration) || duration <= 0) return;
  // The range's MAX is the duration, set once known. A range on a fixed 0-100 scale
  // would make the thumb's position a percentage to convert every frame, and would
  // quantise every seek to 1% of the film.
  if (Number(els.scrubber.max) !== duration) {
    els.scrubber.max = String(duration);
    paintDifficulty(duration);
  }
  // Not while the pointer is on the thumb: writing `value` mid-drag fights the drag,
  // which is the classic scrubber bug.
  if (!scrubbing) els.scrubber.value = String(now);
  els.scrubber.style.setProperty('--played', `${(now / duration) * 100}%`);
}

/**
 * Paint the difficulty band: one span per RUN of cues at the same level.
 *
 * **Runs, not one span per cue.** Adjacent cues of the same level drawn separately
 * leave hairline gaps from rounding, so the band comes out striped rather than
 * continuous, which reads as noise and hides the thing it is meant to show.
 *
 * Coloured with `levelColour`, the same ramp the word underlines use, so a colour means
 * the same thing here as it does on a word in the transcript. That is what makes this
 * more than a heatmap: the band and the marks are one language.
 *
 * Drawn UNDER the range, so the unplayed track's translucency lets it show through
 * while the played region covers it. Ahead is what matters; behind is history.
 *
 * @param {number} duration
 */
function paintDifficulty(duration) {
  els.cues.replaceChildren();
  // Before metadata arrives the duration is 0 or NaN, so every percentage would be
  // Infinity and the band would be drawn off the end of the bar. Nothing to paint yet.
  if (!settings.difficulty || !Number.isFinite(duration) || duration <= 0) return;

  /** The level a cue carries, or 0 for none. */
  const levelOf = (cue) => {
    const levels = (cue.marked ?? []).map((token) => token.level).filter((level) => typeof level === 'number');
    return levels.length ? Math.max(...levels) : 0;
  };

  // Group consecutive cues at the same level into one span.
  const runs = [];
  for (const cue of cues) {
    const level = levelOf(cue);
    if (!level) continue;
    const last = runs.at(-1);
    // A short gap between same-level cues is closed up; a long one is a real break in
    // the difficulty and should show as one.
    if (last && last.level === level && cue.start - last.end < 1.5) {
      last.end = cue.end;
      continue;
    }
    runs.push({ level, start: cue.start, end: cue.end });
  }

  for (const run of runs) {
    const mark = document.createElement('span');
    mark.style.left = `${(run.start / duration) * 100}%`;
    mark.style.width = `${Math.max(0.3, ((run.end - run.start) / duration) * 100)}%`;
    // 60% alpha, the same treatment the comparison page used, the band is a hint
    // under the track, and the played region has to stay readable over it.
    mark.style.background = `color-mix(in srgb, ${levelColour(run.level, 5)} 60%, transparent)`;
    els.cues.append(mark);
  }
}

/** Whether the pointer is on the scrubber, so the tick does not fight a drag. */
let scrubbing = false;

els.scrubber.addEventListener('pointerdown', () => {
  scrubbing = true;
});
els.scrubber.addEventListener('pointerup', () => {
  scrubbing = false;
});
// Keyboard seeking has no pointer, so it reports through `input` alone.
els.scrubber.addEventListener('input', () => {
  const value = Number(els.scrubber.value);
  if (Number.isFinite(value)) els.video.currentTime = value;
  // Painted immediately as well as on the next tick, so the counter keeps up with a
  // keyboard seek rather than lagging a frame behind the thumb.
  paintTime();
});
els.scrubber.addEventListener('change', () => {
  scrubbing = false;
});

// --- The bar's lifecycle -----------------------------------------------------
//
// ONE mechanism: the bar is visible or it is not, and it becomes not-visible when
// the pointer has been idle. There was briefly a second mechanism, an
// expanded/collapsed pair with a chevron, and it was removed: three states where
// every player has two, and the chevron was what made the bar unpredictable.

/**
 * Whether the bar is being held open by something other than the pointer.
 *
 * **An error is the reason this exists.** The bar's normal rule is to fade when the
 * pointer leaves, but a failure the user has to act on must not be able to hide
 * itself, a red line that fades after 2.5s over a black video is worse than no
 * message at all. While this is true, the idle timer does nothing.
 */
function statusPinned() {
  // Errors NO LONGER pin the bar open. The user's call: an error is shown, and the
  // bar may still fade, the alternative was a bar that refused to get out of the
  // way, and a failure that lingers over a video is its own annoyance. The status
  // line itself persists in the DOM, so the message is not lost, only the bar it
  // sits in fades like any other chrome.
  return false;
}

/** Set the status line, and keep the bar open if it is an error. */
function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
  if (isError) showBar();
  scheduleHide();
}

/** The bar's own height, so the overlay captions can sit above it. */
function measureBar() {
  const height = els.bar.getBoundingClientRect().height;
  // A hidden bar still has a height (it is faded, not removed), so this is stable
  // whether or not the pointer is about. Falls back to a sane value at first paint,
  // before layout has settled.
  if (height > 0) document.documentElement.style.setProperty('--bar-offset', `${Math.round(height)}px`);
}

let idleTimer = null;
let focused = false;
let idleEnabled = true;

function showBar() {
  els.bar.dataset.hidden = 'false';
}

/**
 * Hide the bar after a period without movement.
 *
 * Three things stop it, and each is a case where hiding would be wrong:
 *   - `focused`, because a keyboard user must never have an invisible control
 *     receive their focus. This is the trap pointer-only hiding walks into.
 *   - `paused`, because pausing is what people do right before reaching for a
 *     control.
 *   - `statusPinned()`, because an error must stay readable.
 */
function scheduleHide() {
  clearTimeout(idleTimer);
  if (!idleEnabled || focused || els.video.paused || statusPinned()) return;
  idleTimer = setTimeout(() => {
    // Re-checked at fire time: the video may have paused, or focus arrived, or an
    // error appeared since the timer was set.
    if (!focused && !els.video.paused && !statusPinned()) els.bar.dataset.hidden = 'true';
  }, 2500);
}

// Any pointer movement over the picture brings it back.
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

els.video.addEventListener('pause', () => {
  showBar();
  scheduleHide();
});
els.video.addEventListener('play', () => {
  syncPlayIcon();
  scheduleHide();
});
els.video.addEventListener('pause', syncPlayIcon);

// --- Controls ----------------------------------------------------------------

document.getElementById('pp-play').addEventListener('click', () => {
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
  const path = document.getElementById('pp-play-path');
  const button = document.getElementById('pp-play');
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

// The caption toggle, and the placement switch. Independent of the bar's
// visibility: reading the subtitles with the controls hidden is a normal way to
// watch.
document.getElementById('pp-captions').addEventListener('click', (event) => {
  setCaptions(event.currentTarget.getAttribute('aria-pressed') !== 'true');
});

// The difficulty toggle. Same button contract as the caption toggle: the setting
// lives in the button, so clicking never has to know what the state was.
document.getElementById('pp-difficulty').addEventListener('click', (event) => {
  setDifficulty(event.currentTarget.getAttribute('aria-pressed') !== 'true');
});

// The audio track button. It is a disclosure, not a toggle: it opens the panel and
// says so with `aria-expanded`. The `aria-pressed` is kept in step as well so the
// button picks up the same "this is currently active" styling as its neighbours.
els.audioButton.addEventListener('click', () => {
  // Hidden means there is nothing to choose, so the control is not on screen and
  // activating it must be a no-op, without this, a click on the hidden button of a
  // single-track file left the panel flagged open. Unavailable is different: the panel
  // opens, it just explains instead of listing.
  if (els.audioButton.hidden) return;
  audioPanelOpen = !audioPanelOpen;
  applyAudio();
});

els.audioSelect.addEventListener('change', (event) => {
  selectAudioTrack(Number(event.target.value));
});

els.muteButton.addEventListener('click', () => {
  setMuted(els.muteButton.getAttribute('aria-pressed') !== 'true');
});

els.volumeSlider.addEventListener('input', (event) => {
  setVolume(Number(event.target.value));
});

for (const chip of document.querySelectorAll('[data-placement]')) {
  chip.addEventListener('click', () => {
    settings.captionPlacement = chip.dataset.placement;
    saveSettings();
    applyCaptions();
  });
}

document.getElementById('pp-reading').addEventListener('change', (event) => {
  settings.romaji = event.target.value;
  saveSettings();
});

document.getElementById('pp-marks').addEventListener('change', (event) => {
  settings.markStyle = event.target.value;
  saveSettings();
});

document.getElementById('pp-caption-size').addEventListener('input', (event) => {
  const size = Number(event.target.value);
  if (!Number.isFinite(size)) return;
  settings.captionSize = Math.min(34, Math.max(12, Math.round(size)));
  saveSettings();
  applyCaptions();
});

/**
 * Open another file.
 *
 * Changing what is playing while something is playing is a real thing to want, so
 * this picks a file, swaps the object URL and re-reads the cue list, the sequence
 * the reader runs. `URL.revokeObjectURL` on the way out, because a blob URL pins its
 * file and picking a 4GB film then another would hold both until the tab closes.
 */
document.getElementById('pp-open').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*,.mkv,.mp4,.webm';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    pickedFile = file;
    paintFilename();
    els.placeholder.hidden = true;
    els.resume.hidden = true;
    els.video.src = objectUrl;
    // A picked file has no sidecar on disk, so the cue list falls back to
    // placeholders, and the status says so rather than showing invented lines as
    // though they were the file's.
    void loadCues(null);
    setNote(`opened ${file.name}`);
  });
  input.click();
});

/**
 * Click the picture to play/pause.
 *
 * Not a nicety: when the bar has hidden itself it sets `pointer-events: none`, so a
 * click in that region lands on the stage. With no handler there the click does
 * nothing at all, which reads as the app being frozen. Any click that lands on a
 * control is left alone, or pressing a button would also toggle playback under it.
 */
els.stage.addEventListener('click', (event) => {
  if (event.target.closest('.pp-bar')) return;
  if (els.video.paused) void els.video.play();
  else els.video.pause();
});

document.getElementById('pp-back').addEventListener('click', () => {
  els.video.currentTime = Math.max(0, els.video.currentTime - 5);
});

document.getElementById('pp-fwd').addEventListener('click', () => {
  els.video.currentTime = Math.min(els.video.duration || Infinity, els.video.currentTime + 5);
});

/**
 * Cue stepping, the control a generic player cannot have.
 *
 * `+0.05` on the step so landing "on" a boundary is INSIDE the cue rather than a
 * hair before it, where float rounding puts you in the previous one. This is the
 * kind of thing that looks like an off-by-one and is really a seek artefact.
 */
document.getElementById('pp-prev-cue').addEventListener('click', () => {
  const index = activeCueIndex(els.video.currentTime);
  if (!cues.length) return;
  const target = index <= 0 ? cues[0].start : cues[index - 1].start;
  els.video.currentTime = target + 0.05;
});

document.getElementById('pp-next-cue').addEventListener('click', () => {
  const index = activeCueIndex(els.video.currentTime);
  if (index < 0 || !cues.length) return;
  const next = cues[index + 1];
  if (next) els.video.currentTime = next.start + 0.05;
});

document.getElementById('pp-replay-cue').addEventListener('click', () => {
  const index = activeCueIndex(els.video.currentTime);
  if (index >= 0) els.video.currentTime = cues[index].start + 0.05;
});

document.getElementById('pp-speed').addEventListener('change', (event) => {
  settings.defaultSpeed = event.target.value;
  saveSettings();
  els.video.playbackRate = Number(settings.defaultSpeed);
});

document.getElementById('pp-pip').addEventListener('click', () => {
  if (document.pictureInPictureElement) void document.exitPictureInPicture();
  else void els.video.requestPictureInPicture().catch(() => {});
});

// Fullscreen the STAGE, not the video. This is what lets the bar be a sibling of
// the fullscreened element; `video.requestFullscreen()` takes the media element
// alone and only that element and its descendants are rendered, so no overlay bar
// could ever appear on it.
document.getElementById('pp-full').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void els.stage.requestFullscreen().catch(() => {});
});

document.addEventListener('fullscreenchange', () => {
  showBar();
  measureBar();
  scheduleHide();
});

// --- The mock's own switches -------------------------------------------------

document.getElementById('pp-idle').addEventListener('click', (event) => {
  idleEnabled = !idleEnabled;
  event.currentTarget.setAttribute('aria-pressed', String(idleEnabled));
  event.currentTarget.textContent = idleEnabled ? 'on' : 'off';
  if (idleEnabled) scheduleHide();
  else showBar();
});

document.getElementById('pp-native').addEventListener('click', (event) => {
  const on = els.video.hasAttribute('controls');
  if (on) els.video.removeAttribute('controls');
  else els.video.setAttribute('controls', '');
  event.currentTarget.setAttribute('aria-pressed', String(!on));
  event.currentTarget.textContent = !on ? 'on' : 'off';
});

/**
 * Raise and clear a failure, so the error pinning can be seen.
 *
 * A real failure is a container the browser refuses or a track that could not be
 * read; this is the same status path with a message that is easy to trigger on
 * demand.
 */
let failing = false;
function toggleError() {
  failing = !failing;
  if (failing) {
    setStatus('Could not read subtitle tracks from this video. Use a .srt file.', true);
    setNote('error raised, the bar cannot hide while it is up');
  } else {
    setStatus('Ready');
    setNote('error cleared');
  }
}
document.getElementById('pp-error').addEventListener('click', toggleError);
document.getElementById('pp-error2').addEventListener('click', toggleError);

/** @param {string} message */
function setNote(message) {
  els.note.textContent = message;
}

// --- Resuming, and the reload ------------------------------------------------

els.resume.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'pp-resume-go') {
    els.video.currentTime = Number(els.resume.dataset.seconds);
  }
  els.resume.hidden = true;
});

for (const id of ['pp-reload', 'pp-reload2']) {
  document.getElementById(id).addEventListener('click', () => {
    setNote('reloading…');
    // A REAL reload. The position survives it in localStorage, which is the point
    // being demonstrated, and a reload genuinely loses the video, exactly as it
    // does today. Settings survive too, so the bar comes back as it was left.
    location.reload();
  });
}

// --- Load --------------------------------------------------------------------

/**
 * Load the cue list.
 *
 * Real when there is a sidecar to fetch (the extracted subtitle track), placeholders
 * when there is not (a file the user just picked, which has no sidecar on disk).
 * `cuesAreReal` is what lets the status be honest about which it got.
 *
 * @param {string|null} srtUrl
 */
async function loadCues(srtUrl) {
  if (!srtUrl) {
    cues = placeholderCues(els.video.duration);
    cuesAreReal = false;
  } else {
    try {
      const response = await fetch(srtUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      cues = parseSrt(await response.text());
      cuesAreReal = cues.length > 0;
      if (!cues.length) cues = placeholderCues(els.video.duration);
    } catch {
      // A failed fetch is not a failure of the page, the cues are a preview aid.
      cues = placeholderCues(els.video.duration);
      cuesAreReal = false;
    }
  }
  // SYNTHETIC marks, clearly labelled as such.
  //
  // The preview has no dictionary and its sample is an English film, so nothing would
  // ever be marked and the strip would be an empty bar, a control whose whole purpose
  // is invisible in the one place built to look at it.
  //
  // The levels are sampled from a SHAPE by position in the file, not handed out by cue
  // index. A cue's difficulty belongs to where it is in the film; indexing by cue would
  // make the ramp an artifact of how the subtitles happen to be split.
  //
  // The shape itself is deliberate: an easy opening, a stretch where new vocabulary
  // lands, a quiet middle, then a hard run to the end. A uniform wash would tell you
  // nothing about whether the design works, the thing being judged is whether the
  // difficulty RAMP reads.
  //
  // NOTE the sample is 46 seconds with five cues, so the ramp is coarse here. It is a
  // fair answer to "what does it look like now" and an unfair one to "does it read on a
  // 24-minute episode"; the variation this shows is the floor, not the ceiling.
  const SHAPE = [
    0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 2,
    2, 3, 3, 2, 2, 1, 1, 2, 2, 0, 0, 0,
    1, 1, 1, 1, 1, 2, 3, 3, 4, 4, 4, 5,
  ];
  const length = els.video.duration;
  cues.forEach((cue) => {
    const at = length ? (cue.start + cue.end) / 2 / length : 0;
    const level = SHAPE[Math.min(SHAPE.length - 1, Math.floor(at * SHAPE.length))];
    cue.marked = level ? [{ text: cue.text, defined: true, level, reading: null }] : [];
  });
  paintDifficulty(els.video.duration);
}

els.video.addEventListener('loadedmetadata', () => {
  els.placeholder.hidden = true;
  void loadCues(SRT_URL).then(() => {
    setNote(
      `${cues.length} cues${cuesAreReal ? '' : ' (placeholders, no subtitle track)'} · ${SOURCE}`,
    );
    els.video.playbackRate = Number(settings.defaultSpeed);
    document.getElementById('pp-speed').value = settings.defaultSpeed;
    lastCueIndex = -2;
    applyCaptions();
    // After metadata: `audioTracks` is populated by the demuxer, so before it there is
    // nothing to list. Calling earlier would render an empty panel and hide the button.
    applyAudio();
    els.status.textContent = cues.length ? `${cues.length} lines` : 'No subtitle track';
    tick();

    // After metadata, not before: a seek needs a duration to be valid against.
    offerResume();
  });
});

els.video.addEventListener('error', () => {
  const code = els.video.error?.code;
  const isMatroska = /\.mkv$/i.test(SOURCE);
  els.placeholderError.textContent =
    `Could not play ${SOURCE}` + (code ? ` (media error ${code})` : '') +
    (isMatroska
      ? '\nThis browser will not play the MKV container. It is not the codec, H.264 in MP4 plays fine. Check MKV in real Chrome; the VS Code integrated browser cannot, and neither can most embedded views.'
      : '\nPass ?src=/path/to/file to try another one.');
  setStatus('Media error, this file could not be played', true);
});

// --- Start -------------------------------------------------------------------

loadSettings();
applyCaptions();
applyDifficulty();
// Before the file loads, so the stored level is in force from the first frame rather
// than arriving a moment in.
applyVolume();
paintFilename();
setBarState();
showBar();
els.video.src = SOURCE;

/** Apply the placement and reading selects from the stored settings at start. */
function setBarState() {
  document.getElementById('pp-reading').value = settings.romaji;
  document.getElementById('pp-marks').value = settings.markStyle;
  document.getElementById('pp-caption-size').value = String(settings.captionSize);
  document.documentElement.style.setProperty('--caption-size', `${settings.captionSize}px`);
  for (const chip of document.querySelectorAll('[data-placement]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.placement === settings.captionPlacement));
  }
  measureBar();
}
