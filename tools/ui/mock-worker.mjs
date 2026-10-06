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
import { loadDictionary, lookup, levelOf, DATA_PATH } from '../../src/learn/wordlist.js';
import { segmentSegments } from '../../src/learn/segment.js';

/**
 * Mark a line the way the worker does, using the REAL dictionary and segmenter.
 *
 * This used to hash words into fake levels, on the reasoning that the preview
 * only needed to show the layout of marks. That was wrong: a demo whose word list
 * is invented cannot be used to judge whether the highlighting looks right, and
 * "Preview list" in the dropdown gives no idea which words are actually being
 * caught. The real dictionary is 1.4MB, loads in the browser, and is the same code
 * the extension runs.
 *
 * @param {string} text
 * @param {object} dictionary
 * @param {object} list
 * @param {number} threshold
 * @returns {object[]}
 */
function markLine(text, dictionary, list, threshold) {
  const [tokens] = segmentSegments([{ start: 0, text }], dictionary.headwords, dictionary.maxWordLength);
  return tokens.map((token) => {
    const defined = token.known && Boolean(lookup(dictionary, token.text));
    if (!defined || !list) return { text: token.text, defined, level: null };
    const level = levelOf(dictionary, list.id, token.text);
    if (level === null || level < threshold) return { text: token.text, defined, level: null };
    return { text: token.text, defined, level };
  });
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

  // The REAL dictionary and word lists, loaded lazily.
  //
  // Using the real one is the difference between a demo that shows whether the
  // highlighting looks right and one that shows coloured rectangles of the right
  // size. It also puts real list names (HSK 2.0, HSK 3.0) and real levels in the
  // controls, which is what you need to judge them.
  //
  // NOT awaited here. `loadDictionary` reaches for `chrome.runtime.getURL`, and
  // `globalThis.chrome` is installed by `installMockChrome` AFTER this function
  // returns — so loading at construction time read an undefined `chrome` and the
  // dictionary silently failed, taking every mark with it. Deferred to `start()`,
  // by which point the mock is in place.
  let dictionary = null;
  let list = null;
  const ready = () =>
    // The URL is resolved here, as the worker does: `learn/` is a data module and
    // does not know it is running in a browser.
    loadDictionary(chrome.runtime.getURL(DATA_PATH))
      .then((loaded) => {
        dictionary = loaded;
        list = loaded.lists.find((l) => l.id === settings.listId) ?? loaded.lists[0];
      })
      .catch((error) => {
        // Loud, because a preview with no marks looks like a marking bug rather
        // than like the dictionary having failed to load.
        console.error('[ui-preview] the word list did not load:', error?.message ?? error);
      });

  const threshold = () => scenario.forceThreshold ?? settings.threshold ?? list?.defaultThreshold ?? 1;

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

  /** Mark every token, with the real dictionary and segmenter. */
  const markTokens = (text) => (dictionary && list ? markLine(text, dictionary, list, threshold()) : undefined);

  const buildRows = () => {
    const study = segmentsFor(settings.studyLanguage, effectiveTranslation('study')) ?? [];
    const gloss = settings.glossLanguage
      ? segmentsFor(settings.glossLanguage, effectiveTranslation('gloss')) ?? []
      : [];
    const aligned = study.length && gloss.length ? alignSecondary(study, gloss) : null;

    return study.map((segment, index) => ({
      start: segment.start,
      duration: segment.duration,
      text: segment.text,
      secondary: aligned ? aligned[index] : '',
      // Marks are dropped when the study line is machine output, because the word
      // list describes the source language and a translation no longer holds those
      // words — the same rule the worker applies.
      tokens: effectiveTranslation('study') ? undefined : markTokens(segment.text),
    }));
  };

  const state = () => {
    const rows = scenario.error || !scenario.tracks.length ? [] : buildRows();
    const lists = dictionary ? dictionary.lists : [];
    const levels = list?.levelCount ?? 0;
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
      studyTranslation: effectiveTranslation('study'),
      glossTranslation: effectiveTranslation('gloss'),
      translateInto: settings.translateInto,
      studyTranslated: Boolean(settings.studyTranslated),
      glossTranslated: Boolean(settings.glossTranslated),
      rows,
      activeIndex,
      activePaused,
      error: scenario.error ?? null,
      learning: {
        view: settings.view,
        layout: settings.layout,
        fontSize: settings.fontSize,
        listId: list?.id ?? null,
        threshold: threshold(),
        studyLanguage: settings.studyLanguage,
        glossLanguage: settings.glossLanguage,
        translateInto: settings.translateInto,
        studyTranslated: settings.studyTranslated,
        glossTranslated: settings.glossTranslated,
        // The REAL lists, so the control says HSK 2.0 / HSK 3.0 and the levels are
        // the levels those lists actually have.
        listOptions: lists.map((l) => ({ value: l.id, label: l.label })),
        thresholdOptions: Array.from({ length: levels }, (_, i) => ({
          value: i + 1,
          label: `${i + 1}+`,
        })),
      },
      // The panel reads the level count off the list it is marking against.
      lists: lists.map((l) => ({ id: l.id, label: l.label, levelCount: l.levelCount })),
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

  // Rebuilt on every state push, which is why nothing caches the rows.
  //
  // A threshold change has to produce different TOKENS, not just a different
  // control value: the marks are what the setting affects. The earlier version
  // rebuilt rows from a threshold read at build time, so a setting arriving
  // mid-session left the old marks on screen and the change looked ignored.

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
      case MSG.SET_THRESHOLD:
        // A threshold change changes the MARKS, so the rows have to be rebuilt —
        // it is not a control value that only the panel cares about. Without this
        // the mock logged the message as unhandled and the marks stayed as they
        // were, which made the threshold look broken in the preview.
        settings.threshold = Number(message.threshold) || 1;
        push();
        return;
      case MSG.SET_LIST:
        settings.listId = message.listId;
        list = dictionary?.lists.find((l) => l.id === settings.listId) ?? list;
        push();
        return;
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
    start: async () => {
      // Wait for the dictionary before the first push, so the panel's first render
      // already has marks. Pushing unmarked rows and marking a moment later is
      // what the extension does, but in a preview it just looks like flashing.
      await ready();

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
      // The word list loader resolves its data through this, exactly as the real
      // extension does. Vite serves `/src/...` from the repository root, so the
      // URL maps straight onto the committed dictionary.
      getURL: (path) => `/${path}`,
      // The panel reads this after a disconnect. Nothing disconnects here, but
      // the property has to exist or reading it throws.
      get lastError() {
        return undefined;
      },
    },
  };

  return { worker, port: worker.port };
}
