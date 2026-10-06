/**
 * A mock service worker that speaks the panel's real port protocol.
 *
 * The panel's entire contact with the extension is `chrome.runtime.connect`
 * returning a Port it sends messages on and receives messages from. Nothing else
 * in the panel's import graph touches `chrome` at all. So standing a page up in a
 * browser with a fake Port is enough to run the real panel, real stylesheet and
 * real rendering — no extension loading, no Chrome flags, no headless browser.
 *
 * The messages are the REAL ones (`../src/common/messages.js`), not copies. A
 * mock that invented its own protocol would drift, and the drift would look like
 * the panel being broken.
 *
 * This file is loaded BY THE BROWSER, so it must import nothing that touches the
 * filesystem. The scenario arrives as an argument — serialised by the server from
 * `scenarios.mjs`, which is Node-only. Importing that from here makes the browser
 * try to fetch `node:fs`, and the panel silently stays on its placeholder while
 * the console complains about CORS.
 *
 * This is a development tool. It ships in `tools/`, is never loaded by the
 * extension, and is not part of any test.
 */

import { MSG, TARGET } from '../../src/common/messages.js';
import { alignSecondary } from '../../src/common/transcript.js';
import { normalise } from '../../src/common/settings.js';

/**
 * The word list the preview pretends to be grading against.
 *
 * Deliberately small and coarse. The real levels come from a 1.4MB dictionary in
 * the worker; a preview only needs enough spread to see the colour ramp and the
 * threshold working, and pretending to more than that would make the tool look
 * like it had validated the marking rather than the layout.
 */
const PREVIEW_LIST = { id: 'preview', label: 'Preview list', levelCount: 3 };

/**
 * Whether a character is "known", and at what level.
 *
 * A cheap hash rather than a lookup, so the preview shows a plausible spread of
 * marked and unmarked words on any text. The point is the LAYOUT of marks, not
 * which words they land on — and a real dictionary here would be a second source
 * of truth to keep in step.
 *
 * @param {string} text
 * @returns {number|null} 1-based level, or null when unmarked.
 */
function previewLevel(text) {
  if (!text) return null;
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) % 997;
  // Roughly a third unmarked, so "nothing here is marked" is visible as a state
  // rather than assumed from a wall of colour.
  if (hash % 3 === 0) return null;
  return (hash % PREVIEW_LIST.levelCount) + 1;
}

/** How often the mock playhead advances, in ms. */
const TICK_MS = 120;

/**
 * A fake `chrome.runtime.Port` and the panel talking over it.
 *
 * Deliberately shaped like the real thing — `postMessage`, `onMessage`,
 * `onDisconnect` — because the panel calls all three and a preview that quietly
 * omitted one would not exercise the same code path.
 */
export class MockPanelPort {
  constructor() {
    /** @type {Set<Function>} */
    this.messageListeners = new Set();
    /** @type {Set<Function>} */
    this.disconnectListeners = new Set();
    this.onMessage = { addListener: (fn) => this.messageListeners.add(fn) };
    this.onDisconnect = { addListener: (fn) => this.disconnectListeners.add(fn) };
  }

  /** @param {object} message */
  postMessage(message) {
    this.received(message);
  }

  /** @param {object} message */
  deliver(message) {
    for (const listener of this.messageListeners) listener(message);
  }

  disconnect() {
    for (const listener of this.disconnectListeners) listener();
  }

  /** Replaced by the mock worker. @param {object} _message */
  received(_message) {}
}

/**
 * Build the mock worker for one scenario.
 *
 * @param {object} scenario
 * @returns {{port: MockPanelPort, settings: object, start: Function, stop: Function, setTime: Function}}
 */
export function createMockWorker(scenario) {
  const port = new MockPanelPort();

  let settings = normalise({
    primaryLanguage: scenario.settings.studyLanguage,
    secondaryLanguage: scenario.settings.glossLanguage,
    ...scenario.settings,
  });

  /** The tracks this scenario offers, as YouTube would report them. */
  const trackList = scenario.tracks.map((t) => ({
    languageCode: t.languageCode,
    name: t.name ?? t.languageCode,
    kind: t.kind ?? null,
    isTranslatable: Boolean(t.isTranslatable),
  }));

  /** Translation targets, as the video would report them. */
  const translationLanguages = [
    { languageCode: 'en', name: 'English' },
    { languageCode: 'zh-Hans', name: 'Chinese (Simplified)' },
    { languageCode: 'ja', name: 'Japanese' },
    { languageCode: 'ko', name: 'Korean' },
  ].filter((l) => l.languageCode !== null);

  /**
   * The cues for one rendering, applying the translation the way the content
   * script does: the same cues with different text, marked so it is obvious.
   */
  const segmentsFor = (languageCode, translateTo) => {
    const source = scenario.tracks.find((t) => t.languageCode === languageCode);
    if (!source) return null;

    let segments = source.segments;
    if (scenario.stretchLongestCue) {
      // Push one cue far past any real length, so wrapping and row height can be
      // judged at their worst rather than at their typical.
      const longest = segments.reduce((a, b) => (a.text.length >= b.text.length ? a : b));
      segments = segments.map((s) =>
        s === longest ? { ...s, text: `${s.text} ${s.text} ${s.text} ${s.text}` } : s,
      );
    }
    if (!translateTo) return segments;
    return segments.map((s) => ({ ...s, text: `[${translateTo}] ${s.text}` }));
  };

  /**
   * The translation in effect for a role, mirroring `effectiveTranslation` in the
   * worker: the study line is never translated, and a track YouTube will not
   * translate yields nothing however loudly it is asked.
   */
  const effectiveTranslation = (role) => {
    if (role !== 'gloss') return null;
    if (!settings.glossTranslated || !settings.translateInto) return null;
    const languageCode = settings.glossLanguage;
    if (!languageCode || languageCode === settings.translateInto) return null;
    const t = trackList.find((x) => x.languageCode === languageCode);
    return t?.isTranslatable ? settings.translateInto : null;
  };

  /** Mark every token, the way `applyMarks` does — one hash, no dictionary. */
  const markTokens = (text) =>
    [...text].map((char) => {
      const level = scenario.noMarks ? null : previewLevel(char);
      return { text: char, defined: level !== null, level };
    });

  const buildRows = () => {
    const threshold = scenario.forceThreshold ?? settings.threshold ?? 1;
    const study = segmentsFor(settings.studyLanguage, null) ?? [];
    const gloss = settings.glossLanguage
      ? segmentsFor(settings.glossLanguage, effectiveTranslation('gloss')) ?? []
      : [];
    const aligned = study.length && gloss.length ? alignSecondary(study, gloss) : null;

    return study.map((segment, index) => ({
      start: segment.start,
      duration: segment.duration,
      text: segment.text,
      secondary: aligned ? aligned[index] : '',
      // Level comes back on each token, but a token below the threshold is
      // unmarked — the same rule the worker applies, so the preview can show a
      // transcript with nothing highlighted at all.
      tokens: markTokens(segment.text).map((token) =>
        token.level !== null && token.level >= threshold ? token : { ...token, level: null },
      ),
    }));
  };

  const state = () => {
    const rows = scenario.error || !scenario.tracks.length ? [] : buildRows();
    return {
      videoId: 'preview',
      title: scenario.error ? '' : 'Preview video',
      isLive: false,
      trackList,
      translationLanguages,
      translationAvailable: Object.fromEntries(
        trackList.map((t) => [t.languageCode, Boolean(t.isTranslatable)]),
      ),
      study: settings.studyLanguage,
      gloss: settings.glossLanguage,
      glossTranslation: effectiveTranslation('gloss'),
      translateInto: settings.translateInto,
      glossTranslated: Boolean(settings.glossTranslated),
      rows,
      activeIndex,
      activePaused,
      error: scenario.error ?? null,
      learning: {
        view: settings.view,
        fontSize: settings.fontSize,
        listId: PREVIEW_LIST.id,
        threshold: scenario.forceThreshold ?? settings.threshold ?? 1,
        studyLanguage: settings.studyLanguage,
        glossLanguage: settings.glossLanguage,
        translateInto: settings.translateInto,
        glossTranslated: settings.glossTranslated,
        listOptions: [{ value: PREVIEW_LIST.id, label: PREVIEW_LIST.label }],
        thresholdOptions: Array.from({ length: PREVIEW_LIST.levelCount }, (_, i) => ({
          value: i + 1,
          label: `${i + 1}+`,
        })),
      },
      // The panel reads the level count off the list it is marking against.
      lists: [{ ...PREVIEW_LIST, levelCount: PREVIEW_LIST.levelCount }],
    };
  };

  const rows = () => (scenario.error || !scenario.tracks.length ? [] : buildRows());

  // --- Playhead -------------------------------------------------------------
  // A fake clock rather than a real <video>: the preview is for laying the panel
  // out, and a video element would add a dependency on a file that is not
  // committed.
  let seconds = 0;
  let activeIndex = -1;
  let activePaused = true;
  let timer = 0;

  const cueAt = (time) => {
    const cues = rows();
    // The same "hold the last line through a gap" rule `findActiveIndex` uses,
    // including the dimmed state — that behaviour is the point of the preview.
    let index = -1;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (time >= cue.start && time < cue.start + cue.duration) return { index: i, paused: false };
      if (time >= cue.start) index = i;
    }
    return { index, paused: index >= 0 };
  };

  const push = () => port.deliver({ type: MSG.STATE, state: state() });
  const pushPosition = () => port.deliver({ type: MSG.POSITION, index: activeIndex, seconds, paused: activePaused });

  const tick = () => {
    seconds += TICK_MS / 1000;
    const { index, paused } = cueAt(seconds);
    if (index !== activeIndex || paused !== activePaused) {
      activeIndex = index;
      activePaused = paused;
      pushPosition();
    }
    if (seconds > (rows().at(-1)?.start ?? 0) + 6) seconds = 0;
  };

  port.received = (message) => {
    if (message?.target !== TARGET.BACKGROUND) return;

    switch (message.type) {
      case MSG.REFRESH:
        push();
        return;
      case MSG.SET_STUDY:
        settings.studyLanguage = message.languageCode || null;
        push();
        return;
      case MSG.SET_GLOSS:
        settings.glossLanguage = message.languageCode || null;
        push();
        return;
      case MSG.SEEK: {
        seconds = Number(message.seconds) || 0;
        pushPosition();
        return;
      }
      case MSG.SET_SETTING: {
        settings = normalise({ ...settings, [message.id]: message.value });
        push();
        return;
      }
      default:
        // A look-up, a capture toggle, a list change — none of which the preview
        // can answer honestly. Reported rather than ignored, so a message the
        // panel sends that this mock does not know about is visible.
        console.info('[ui-preview] unhandled message', message);
    }
  };

  return {
    port,
    settings: () => ({ ...settings }),
    // A gap has to be selected deliberately, so the scenario can start there.
    setTime: (value) => {
      seconds = value;
      const { index, paused } = cueAt(seconds);
      activeIndex = index;
      activePaused = paused;
      pushPosition();
    },
    start: () => {
      const gap = scenario.startInGap ? rows().find((row, i) => (rows()[i + 1]?.start ?? 0) - (row.start + row.duration) > 10) : null;
      if (gap) seconds = gap.start + gap.duration + 1;
      push();
      pushPosition();
      timer = setInterval(tick, TICK_MS);
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * Install the mock as `window.chrome` and run the panel.
 *
 * @param {object} scenario
 * @returns {{worker: object, port: MockPanelPort}}
 */
export function installMockChrome(scenario) {
  const worker = createMockWorker(scenario);

  globalThis.chrome = {
    runtime: {
      connect: () => worker.port,
      // The panel reads this after a disconnect. Nothing disconnects here, but
      // the property has to exist or reading it throws.
      get lastError() {
        return undefined;
      },
    },
  };

  return { worker, port: worker.port };
}
