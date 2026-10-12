/**
 * A `chrome.*` stand-in, so the viewer can run as an ordinary web page.
 *
 * ## Why this exists
 *
 * `src/viewer/` is the local-file viewer. It imports only from `src/` and touches
 * exactly four extension APIs:
 *
 *   api.storage[area].get(key), .set(obj)   settings and the remembered positions
 *   api.storage.onChanged.addListener(fn)   how a setting changed in the panel
 *                                           reaches the video
 *   api.runtime.getURL(path)                where the bundled dictionary lives
 *   api.runtime.sendMessage(msg)            tell the service worker where playback is
 *   api.runtime.onMessage.addListener(fn)   messages from the worker
 *
 * On a normal page the last two have nothing to talk to, and the first two have no
 * `chrome.storage`. This provides all four so the same `viewer.js` runs unchanged,
 * which means the demo exercises the shipped code rather than a copy of it. A demo
 * built from a fork would prove nothing about the thing people install.
 *
 * ## Why it is a module and not a classic script
 *
 * The viewer reads `globalThis.browser ?? globalThis.chrome` at its own module
 * scope, so this has to have run first. A classic script would work only if it were
 * placed before the viewer's tag and not deferred, which is a rule that is easy to
 * break later without noticing. Making this a module that `demo-entry.js` imports
 * FIRST relies on the language's own guarantee: an imported module is fully
 * evaluated before the importer's body, so the ordering cannot silently invert.
 *
 * ## What it deliberately does NOT do
 *
 * It does not pretend a service worker exists. `sendMessage` resolves rather than
 * rejecting, so the viewer's own error handling does not fire, and the messages go
 * nowhere. That is honest: on a page there is no panel to sync with, so the
 * position-sharing feature genuinely does not apply.
 *
 * Storage is in-memory, not `localStorage`. A demo has no business leaving state
 * behind on a visitor's machine, and the budget is a few hundred bytes of settings
 * that are cheap to reset. A reload therefore starts clean, which is what you want
 * when the page is a demonstration.
 */

/**
 * The storage namespace the app uses, read from the module that defines it.
 *
 * Imported rather than repeated as `'local'`. That setting is pinned by a test
 * (`storage.sync` is deliberately banned), so a literal here could disagree with
 * the app and the demo would silently not share its storage area with anything.
 */
import { SETTINGS_AREA } from '/src/common/settings.js';

/** @type {Map<string, Record<string, unknown>>} */
const buckets = new Map();

/** @type {Array<(changes: object, area: string) => void>} */
const listeners = [];

/** @param {string} area */
function bucketFor(area) {
  if (!buckets.has(area)) buckets.set(area, {});
  return buckets.get(area);
}

/**
 * One storage area, shaped like `chrome.storage.local`.
 *
 * The real API returns promises when called without a callback, which is what the
 * viewer relies on. Reproduced exactly, including `get` accepting a string, an
 * array, or an object of defaults, because the viewer uses the string form for
 * settings and the string form for positions, and a shim that handled only one
 * would fail on the other.
 *
 * @param {string} area
 */
function areaFor(area) {
  return {
    /** @param {string|string[]|Record<string, unknown>|null} [keys] */
    async get(keys) {
      const bucket = bucketFor(area);
      if (keys == null) return { ...bucket };
      if (typeof keys === 'string') {
        return keys in bucket ? { [keys]: bucket[keys] } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) if (key in bucket) out[key] = bucket[key];
        return out;
      }
      // The defaults form: absent keys come back with their default.
      const out = {};
      for (const [key, fallback] of Object.entries(keys)) {
        out[key] = key in bucket ? bucket[key] : fallback;
      }
      return out;
    },

    /** @param {Record<string, unknown>} items */
    async set(items) {
      const bucket = bucketFor(area);
      /** @type {Record<string, {newValue: unknown, oldValue?: unknown}>} */
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: bucket[key], newValue: value };
        bucket[key] = value;
      }
      // Fired synchronously here, where the real API fires asynchronously. The
      // viewer only reacts by re-reading, so ordering does not matter, and firing
      // after the write (rather than before) is what keeps a listener from seeing a
      // value that has not landed.
      for (const listener of listeners) listener(changes, area);
    },

    /** @param {string|string[]} keys */
    async remove(keys) {
      const bucket = bucketFor(area);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete bucket[key];
    },

    async clear() {
      buckets.set(area, {});
    },
  };
}

/**
 * `chrome.storage`, fanned out over the areas the app asks for.
 *
 * Built from `SETTINGS_AREA` plus the two other names the real API has, so a call
 * to an area this app does not use still resolves rather than throwing.
 */
const storage = {
  local: areaFor('local'),
  sync: areaFor('sync'),
  managed: areaFor('managed'),
  session: areaFor('session'),
  onChanged: {
    /** @param {(changes: object, area: string) => void} listener */
    addListener(listener) {
      listeners.push(listener);
    },
    /** @param {(changes: object, area: string) => void} listener */
    removeListener(listener) {
      const at = listeners.indexOf(listener);
      if (at !== -1) listeners.splice(at, 1);
    },
  },
};

/**
 * `chrome.runtime`, where `getURL` resolves a path relative to the PAGE.
 *
 * The viewer asks for `src/learn/data/index.json` and in the extension gets an
 * absolute `chrome-extension://<id>/src/learn/data/index.json` back. On the demo
 * page the equivalent is a URL relative to wherever the page is served from.
 *
 * **Do NOT prepend a slash.** An earlier version returned `/src/learn/data/...`,
 * which works only when the page is served from the domain root. GitHub Pages
 * serves a project site from `/iu/`, so `/src/...` points one level ABOVE the
 * site and 404s, and the viewer then had no dictionary at all: no word list, no
 * marks. Verified by serving the build under a `/iu/` prefix. The leading-slash
 * comment this replaces argued the opposite, which is why the failure survived
 * review.
 *
 * `new URL(path, document.baseURI)` is the page's own resolution rule, so it is
 * correct at the root, under a subpath, and behind a `<base>` tag alike.
 *
 * @param {string} path
 * @returns {string}
 */
function getURL(path) {
  return new URL(path, document.baseURI).href;
}

/** @type {Array<(message: unknown, sender: unknown, respond: Function) => void>} */
const messageListeners = [];

const runtime = {
  getURL,
  /**
   * Nowhere to send, and that is correct here.
   *
   * Resolves rather than rejects. The viewer retries once and then shows "reopen
   * from the toolbar menu" if this fails, which would be a confusing thing to read
   * on a demo page. Resolving says "the call worked, there was nothing to talk to",
   * which is the truth: no worker exists on a page and none of the features that
   * need one apply.
   *
   * @returns {Promise<never>}
   */
  async sendMessage() {
    return /** @type {never} */ (undefined);
  },
  onMessage: {
    /** @param {(message: unknown, sender: unknown, respond: Function) => void} listener */
    addListener(listener) {
      messageListeners.push(listener);
    },
    removeListener(listener) {
      const at = messageListeners.indexOf(listener);
      if (at !== -1) messageListeners.splice(at, 1);
    },
  },
  lastError: undefined,
  /** The demo is not an extension, so this is absent rather than faked. */
  id: undefined,
};

// Installed on `globalThis` at module scope, so any importer that lists this file
// first has the shim in place before its own body runs. The app checks `browser`
// BEFORE `chrome`, so `browser` is deliberately left undefined rather than copied:
// a copy would be harmless today and a trap the moment the two disagree.
globalThis.chrome = { storage, runtime };

export { storage, runtime, getURL, SETTINGS_AREA };
