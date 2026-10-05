/**
 * Stub engine — emits a placeholder partial/final pair on a timer.
 *
 * Purpose: prove the capture -> offscreen -> side panel pipeline end to end
 * without committing to a real recogniser. It consumes a MediaStream only to
 * keep the capture path honest (the stream must be live for the graph to run);
 * it does not read the samples yet.
 *
 * @typedef {import('./engine.js').TranscriptEvent} TranscriptEvent
 */
export class StubEngine {
  constructor() {
    /** @type {MediaStream | null} */
    this._stream = null;
    /** @type {number | null} */
    this._timer = null;
    /** @type {Set<(event: TranscriptEvent) => void>} */
    this._listeners = new Set();
    this._segment = 0;
  }

  /** @param {(event: TranscriptEvent) => void} listener */
  onEvent(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * @param {MediaStream} stream
   * @returns {Promise<void>}
   */
  async start(stream) {
    if (this._timer !== null) return; // already running
    this._stream = stream;
    for (const track of stream.getAudioTracks()) {
      // Reserved for a real engine: hook an AudioWorklet here to pull PCM.
      track.addEventListener('mute', () => this._emitError('Capture track muted.'));
    }
    // TODO(engine): replace the demo ticker with real recognition.
    this._timer = setInterval(() => this._tick(), 1000);
  }

  /** @returns {Promise<void>} */
  async stop() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._stream = null;
  }

  _tick() {
    const at = Date.now();
    const segment = this._segment++;
    this._emit({ kind: 'partial', text: `… transcribing segment ${segment + 1}`, at });
    this._emit({
      kind: 'final',
      text: `[stub] segment ${segment + 1} recognised`,
      startMs: segment * 1000,
      endMs: (segment + 1) * 1000,
      confidence: 1,
      at,
    });
  }

  /** @param {TranscriptEvent} event */
  _emit(event) {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (err) {
        // A broken listener must not take down the engine.
        console.error('[engine:stub] listener threw', err);
      }
    }
  }

  /** @param {string} message */
  _emitError(message) {
    this._emit({ kind: 'final', text: `⚠ ${message}`, at: Date.now() });
  }
}
