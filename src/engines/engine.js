/**
 * Transcription engine adapter.
 *
 * The engine is deliberately the *only* thing that knows how speech becomes
 * text. Everything upstream (tab capture, offscreen document, side panel) talks
 * to this interface only, so swapping Web Speech <-> whisper.cpp <-> a cloud
 * API is a change in this folder and nowhere else.
 *
 * Contract — an engine is any object with:
 *
 *   start(stream: MediaStream, options?: object): Promise<void>
 *       Begin consuming `stream`. Resolve once started; reject on failure.
 *       Must be idempotent-safe: `start` while running is a no-op.
 *
 *   stop(): Promise<void>
 *       Stop consuming and release every resource. Safe to call when not running.
 *
 *   onEvent(listener: (event: TranscriptEvent) => void): () => void
 *       Subscribe to transcript events. Returns an unsubscribe function.
 *       Engines may emit nothing until they have audio; they must never throw
 *       from a listener callback and must not require a listener to be attached.
 *
 * @typedef {Object} TranscriptEvent
 * @property {'partial' | 'final'} kind
 *   `partial` = a hypothesis that will be replaced (render in place).
 *   `final`   = an immutable segment (append, persist).
 * @property {string} text        Transcript text for this event.
 * @property {number} [startMs]   Offset into the captured audio, if known.
 * @property {number} [endMs]     Offset into the captured audio, if known.
 * @property {number} [confidence] 0..1, if the engine reports one.
 * @property {number} at          Wall-clock ms at emit time (Date.now()).
 */

import { StubEngine } from './stub-engine.js';

/** @type {Map<string, () => object>} */
const registry = new Map();

/**
 * @param {string} name
 * @param {() => object} factory Returns a fresh engine instance.
 */
export function registerEngine(name, factory) {
  registry.set(name, factory);
}

/** @returns {string[]} */
export function listEngines() {
  return [...registry.keys()];
}

/**
 * @param {string} name
 * @returns {object} A fresh engine instance.
 */
export function createEngine(name) {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`Unknown transcription engine: ${name} (have: ${listEngines().join(', ')})`);
  }
  return factory();
}

// --- Registered engines -----------------------------------------------------
// The stub keeps the whole pipeline exercisable before an engine is chosen.
// Add a real one here, e.g.:
//   registerEngine('web-speech', () => new WebSpeechEngine());
registerEngine('stub', () => new StubEngine());
