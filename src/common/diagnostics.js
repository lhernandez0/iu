/**
 * The local diagnostics log.
 *
 * This is a side channel, not a source of truth. It records what happened so a
 * user can export the file and attach it to a report. It never decides what the
 * panel or viewer shows.
 *
 * The hard constraints:
 *   - storage.local only, never the sync storage area;
 *   - no network, no telemetry, no new permission;
 *   - no user content: no page URLs, page titles, video titles or ids, file
 *     names, transcript text, word lookups, cookies, query strings or tab ids;
 *   - one writer, the service worker, so two contexts cannot clobber the same
 *     ring buffer;
 *   - a small, bounded ring: 2,000 entries or 512 KB, whichever comes first,
 *     inside a 30, 60 or 90 day retention window.
 *
 * The schema is deliberately flat. A log that grows nested object graphs is a
 * log nobody can read on a support thread.
 */

export const LOG_KEY = 'diagnostics';
export const LOG_SCHEMA = 1;
export const RETENTION_DAYS = Object.freeze([30, 60, 90]);
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_ENTRIES = 2000;
export const MAX_BYTES = 512 * 1024;

const LEVELS = new Set(['info', 'warn', 'error']);
const SCOPES = new Set(['worker', 'panel', 'content', 'viewer']);

/**
 * Detail fields that are safe to keep. Anything else is dropped.
 *
 * These are phases, counts, formats, codecs, booleans and timings. No field can
 * carry a page or file name because no such key is accepted, and a string value
 * is truncated so a caller cannot smuggle a paragraph through `phase`.
 */
const DETAIL_KEYS = new Set([
  'source', 'phase', 'role', 'provider', 'stage',
  'count', 'ms', 'ok', 'cached', 'windowed', 'percent',
  'codec', 'kind', 'format', 'encoding', 'playable', 'canPlay',
  'bytes', 'ext', 'type', 'readyState', 'networkState', 'tracks', 'cues',
  'step', 'index', 'at', 'errorCode', 'canDecode', 'from', 'to', 'channels',
  'ahead', 'rate',
]);

const MAX_DETAIL_STRING = 60;

/** @typedef {{ schema: number, t: number, level: string, scope: string, event: string, code: string|null, detail: Record<string, string|number|boolean> }} LogEntry */
/** @typedef {{ schema: number, retentionDays: number, entries: LogEntry[] }} LogFile */

/** @param {unknown} value @returns {number} */
const byteLength = (value) => new TextEncoder().encode(String(value)).length;

/** @param {unknown} detail @returns {Record<string, string|number|boolean>} */
export function sanitiseDetail(detail) {
  const out = {};
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return out;
  for (const [key, value] of Object.entries(detail)) {
    if (!DETAIL_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      if (value.length > 0) out[key] = value.slice(0, MAX_DETAIL_STRING);
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
      continue;
    }
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * Build a valid entry from an untrusted caller.
 *
 * @param {{ level?: string, scope?: string, event?: string, code?: string|null, detail?: object }} input
 * @param {number} [time]
 * @returns {LogEntry}
 */
export function makeEntry(input, time = Date.now()) {
  const level = LEVELS.has(input?.level) ? input.level : 'info';
  const scope = SCOPES.has(input?.scope) ? input.scope : 'worker';
  const event = typeof input?.event === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.event)
    ? input.event
    : 'unknown';
  const code = typeof input?.code === 'string' && /^[A-Z]{2,6}\d{3}$/.test(input.code)
    ? input.code
    : null;
  return {
    schema: LOG_SCHEMA,
    t: Math.round(Number(time) || Date.now()),
    level,
    scope,
    event,
    code,
    detail: sanitiseDetail(input?.detail),
  };
}

/** @param {unknown} raw @param {number} time @returns {LogEntry|null} */
function normaliseEntry(raw, time) {
  if (!raw || typeof raw !== 'object') return null;
  const entry = makeEntry(raw, Number(raw.t) || time);
  // makeEntry replaces an invalid time with the current time; a corrupt entry
  // with no usable timestamp is dropped rather than stamped as "now".
  return Number.isFinite(Number(raw.t)) ? entry : null;
}

/**
 * Keep the log inside its retention and size bounds.
 *
 * @param {LogFile} log
 * @param {number} [time]
 * @returns {LogFile}
 */
export function prune(log, time = Date.now()) {
  const cutoff = time - log.retentionDays * 24 * 60 * 60 * 1000;
  log.entries = log.entries
    .filter((entry) => entry.t >= cutoff)
    .sort((a, b) => a.t - b.t);

  while (log.entries.length > MAX_ENTRIES) log.entries.shift();
  while (log.entries.length > 0 && byteLength(JSON.stringify(log)) > MAX_BYTES) log.entries.shift();
  return log;
}

/** @param {unknown} raw @param {number} [time] @returns {LogFile} */
export function normaliseLog(raw, time = Date.now()) {
  const empty = { schema: LOG_SCHEMA, retentionDays: DEFAULT_RETENTION_DAYS, entries: [] };
  if (!raw || typeof raw !== 'object' || raw.schema !== LOG_SCHEMA) return empty;
  const days = RETENTION_DAYS.includes(Number(raw.retentionDays))
    ? Number(raw.retentionDays)
    : DEFAULT_RETENTION_DAYS;
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((entry) => normaliseEntry(entry, time)).filter(Boolean)
    : [];
  return prune({ schema: LOG_SCHEMA, retentionDays: days, entries }, time);
}

/**
 * Build the downloadable file.
 *
 * The first line is a header; every following line is one entry. JSONL rather
 * than one JSON array because a support reader can open it in an editor and see
 * one event per line without pretty-printing a large document.
 *
 * @param {LogFile} log
 * @param {{ version?: string, target?: string, exportedAt?: string }} [meta]
 * @returns {string}
 */
export function toJsonl(log, meta = {}) {
  const header = {
    type: 'header',
    schema: LOG_SCHEMA,
    exportedAt: meta.exportedAt ?? new Date().toISOString(),
    version: meta.version ?? '',
    target: meta.target ?? '',
    retentionDays: log.retentionDays,
    count: log.entries.length,
  };
  return [JSON.stringify(header), ...log.entries.map((entry) => JSON.stringify(entry))].join('\n') + '\n';
}

/**
 * Create the store facade for one context.
 *
 * The worker is the writer. The panel uses `read` and `exportText` only; the
 * clear and retention paths go through the worker so there is one writer.
 *
 * @param {{ storage: { local: { get: Function, set: Function, remove: Function } } }} api
 * @param {{ version?: string, target?: string, now?: () => number }} [options]
 */
export function createDiagnostics(api, { version = '', target = '', now = () => Date.now() } = {}) {
  /** @type {LogFile|null} */
  let cached = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /** @returns {Promise<LogFile>} */
  async function load() {
    let stored = {};
    try {
      stored = await api.storage?.local?.get?.(LOG_KEY);
    } catch {
      stored = {};
    }
    return normaliseLog(stored?.[LOG_KEY], now());
  }

  /** @returns {Promise<LogFile>} */
  async function read() {
    const log = await load();
    cached = log;
    return log;
  }

  /** @param {object} input @returns {Promise<void>} */
  function append(input) {
    const entry = makeEntry(input, now());
    queue = queue
      .then(async () => {
        const log = cached ?? (await load());
        log.entries.push(entry);
        prune(log, now());
        cached = log;
        await api.storage.local.set({ [LOG_KEY]: log });
      })
      .catch(() => {});
    return queue;
  }

  /** @param {number} days @returns {Promise<LogFile>} */
  function setRetention(days) {
    const value = RETENTION_DAYS.includes(Number(days)) ? Number(days) : DEFAULT_RETENTION_DAYS;
    queue = queue
      .then(async () => {
        const log = cached ?? (await load());
        log.retentionDays = value;
        prune(log, now());
        cached = log;
        await api.storage.local.set({ [LOG_KEY]: log });
      })
      .catch(() => {});
    return queue.then(() => read());
  }

  /** @returns {Promise<LogFile>} */
  function clear() {
    queue = queue
      .then(async () => {
        const log = cached ?? (await load());
        const cleared = { schema: LOG_SCHEMA, retentionDays: log.retentionDays, entries: [] };
        cached = cleared;
        await api.storage.local.set({ [LOG_KEY]: cleared });
      })
      .catch(() => {});
    return queue.then(() => read());
  }

  /** @param {LogFile} [log] @param {{ exportedAt?: string }} [meta] */
  async function exportText(log = null, meta = {}) {
    const current = log ?? (await read());
    return toJsonl(current, { version, target, ...meta });
  }

  return { read, append, setRetention, clear, exportText };
}

/** @param {LogFile} log */
export function summarise(log) {
  const entries = log?.entries ?? [];
  return {
    count: entries.length,
    oldest: entries[0]?.t ?? null,
    newest: entries[entries.length - 1]?.t ?? null,
    retentionDays: log?.retentionDays ?? DEFAULT_RETENTION_DAYS,
  };
}
