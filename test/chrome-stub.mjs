import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal stand-in for the `chrome.*` surface the service worker touches.
 *
 * The extension cannot be loaded in Node, but the worker is plain ES modules
 * and its only contact with the browser is the `chrome` global. Stubbing that
 * is enough to actually evaluate the module, which catches a whole class of
 * failure that static checks cannot: anything thrown at module scope. A worker
 * that throws while loading never answers the panel, and the panel just sits on
 * its placeholder, indistinguishable, from the panel's side, from a slow
 * network.
 *
 * Only the surfaces the worker reaches are implemented. Anything else is
 * deliberately absent so that an unexpected dependency fails loudly rather than
 * silently returning undefined.
 */

/**
 * @param {object} [options]
 * @param {object[]} [options.tabs]        Tabs that chrome.tabs.query can return.
 * @param {object[]} [options.frames]      Frames that webNavigation reports.
 * @param {any} [options.describePayload]  What the content script "returns" for DESCRIBE.
 * @param {any} [options.providePayload]   What the content script "returns" for PROVIDE.
 * @param {any} [options.trackPayload]     What it returns for FETCH_TRACK.
 * @param {object} [options.storage]       Pre-existing chrome.storage.local contents.
 * @param {number} [options.storageDelay]  Milliseconds the storage read takes.
 * @param {object[]} [options.contexts]    The extension's own open contexts, a
 *   reader page in a tab, the offscreen document. Empty by default, because a
 *   fresh worker has none.
 * @returns {{listeners: object, calls: object, storage: object}}
 */
export function installChromeStub(options = {}) {
  const {
    tabs = [{ id: 1, active: true, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
    frames = [{ frameId: 0, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
    describePayload = null,
    providePayload = null,
    trackPayload = null,
    storage = {},
    storageDelay = 0,
    contexts = [],
  } = options;

  /** Registrations, so a test can fire the events the browser would. */
  const listeners = {
    message: [],
    connect: [],
    tabActivated: [],
    tabRemoved: [],
    actionClicked: [],
    navigationCommitted: [],
    installed: [],
    menuClicked: [],
  };

  /** Everything the worker asked the browser to do. */
  const calls = {
    executeScript: [],
    sendMessage: [],
    sidePanelOpen: [],
    offscreen: [],
    menusCreated: [],
    menusRemoved: 0,
  };

  const addListener = (bucket) => (fn) => listeners[bucket].push(fn);

  // The worker loads its word list through `fetch` on an extension URL, so the
  // data has to be reachable here.
  //
  // RESOLVED BY FILENAME, not by a `learn/data/` prefix. The prefix version
  // served chinese.json for every data URL, which was correct while there was one
  // dictionary and silently wrong the moment there were two: a test that switched
  // to a JLPT list would have been handed Chinese words and passed, or failed
  // for a reason that had nothing to do with the code under test. Anything not on
  // the allowlist throws, so an unexpected network call in a hermetic test is
  // loud rather than silently returning nothing.
  const SERVED = /learn\/data\/(chinese|japanese|index)\.(json)$/;

  globalThis.fetch = async (url) => {
    const href = String(url);
    const match = SERVED.exec(href);
    if (match) {
      const body = await readFile(resolve(here, '../src/learn/data', `${match[1]}.json`), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    }
    throw new Error(`unexpected fetch in a hermetic test: ${href}`);
  };

  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: addListener('message') },
      onConnect: { addListener: addListener('connect') },
      onInstalled: { addListener: addListener('installed') },
      getURL: (path) => `chrome-extension://test/${path}`,
      // The extension's own open contexts, the reader page in a tab, and the
      // offscreen document.
      //
      // Configurable because it is load-bearing twice over: it is how the worker
      // identifies a reader tab at all (our pages report no `url`, so there is no
      // other way), and it is how the offscreen document is found. A stub that
      // always returned `[]` would leave the reader path untested and pass.
      getContexts: async (filter) => {
        const all = options.contexts ?? [];
        if (!filter?.contextTypes) return all;
        return all.filter((context) => filter.contextTypes.includes(context.contextType));
      },
      // The worker reads this after `contextMenus.create` to suppress the
      // "unchecked runtime.lastError" warning on a duplicate id. Always clear
      // here, because there is no real menu for an id to collide with.
      lastError: undefined,
      // The worker broadcasts to the offscreen document over this; nothing
      // is listening in a test, so a resolved promise is the honest answer.
      sendMessage: async (message) => {
        calls.sendMessage.push(message);
        return { ok: true };
      },
    },
    // The toolbar icon's menu, which is how a source is opened. Present so the
    // registration path actually runs rather than being skipped by the worker's
    // feature detection, a stub that omits this would let a broken menu pass.
    contextMenus: {
      create: (properties, callback) => {
        calls.menusCreated.push(properties);
        callback?.();
      },
      removeAll: (callback) => {
        calls.menusRemoved++;
        callback?.();
      },
      onClicked: { addListener: addListener('menuClicked') },
    },
    tabs: {
      onActivated: { addListener: addListener('tabActivated') },
      onRemoved: { addListener: addListener('tabRemoved') },
      query: async (query) => tabs.filter((t) => query?.active === undefined || t.active === query.active),
      get: async (id) => tabs.find((t) => t.id === id) ?? null,
      sendMessage: async (tabId, message, frameOptions) => {
        calls.sendMessage.push({ tabId, message, frameOptions });
        if (message?.type === 'describe') return answers.describePayload;
        if (message?.type === 'provide') return answerFor(answers.providePayload, message);
        if (message?.type === 'fetch-track') return answerFor(answers.trackPayload, message);
        return { ok: true };
      },
    },
    webNavigation: {
      getAllFrames: async () => frames,
      onCommitted: { addListener: addListener('navigationCommitted') },
    },
    scripting: {
      executeScript: async (arg) => {
        calls.executeScript.push(arg);
        return [];
      },
    },
    storage: (() => {
      // The `storage` option is the SETTINGS bucket, the one `SETTINGS_AREA`
      // names, which is `local`. Kept by reference so `stub.storage.settings` is
      // what a test reads to see what was persisted, which is the assertion most
      // of these tests make.
      //
      // `sync` exists so it is present but stays EMPTY, and `manifest.test.mjs`
      // fails the build if any source file mentions it. Nothing here seeds it,
      // because nothing should write to it: preferences staying on the machine is
      // a project decision, not an implementation preference.
      const settingsBucket = storage;
      const syncBucket = {};

      const listeners = [];

      /** Fire the cross-context event a real write fires, so subscribers run. */
      const notify = (area, changes) => {
        for (const handler of [...listeners]) handler(changes, area);
      };

      const areaFor = (bucket, source) => ({
        get: async (key) => {
          // A real storage read is not instant. Making it visibly slow is what
          // lets a test catch startup code that reads a stored value only after
          // it has already been used.
          if (storageDelay) await new Promise((done) => setTimeout(done, storageDelay));
          return key in bucket ? { [key]: bucket[key] } : {};
        },
        set: async (items) => {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: bucket[key], newValue: value };
            bucket[key] = value;
          }
          // A write with nothing in it does not fire in Chrome either, and firing
          // here would make a listener-count assertion depend on how many times a
          // value was redundantly re-persisted.
          if (Object.keys(changes).length) notify(source, changes);
        },
        remove: async (key) => {
          const keys = Array.isArray(key) ? key : [key];
          const changes = {};
          for (const k of keys) {
            changes[k] = { oldValue: bucket[k] };
            delete bucket[k];
          }
          if (Object.keys(changes).length) notify(source, changes);
        },
      });

      return {
        local: areaFor(settingsBucket, 'local'),
        sync: areaFor(syncBucket, 'sync'),
        onChanged: {
          addListener: (fn) => listeners.push(fn),
          removeListener: (fn) => {
            const at = listeners.indexOf(fn);
            if (at !== -1) listeners.splice(at, 1);
          },
        },
      };
    })(),
    action: { onClicked: { addListener: addListener('actionClicked') } },
    sidePanel: {
      open: async (arg) => {
        calls.sidePanelOpen.push(arg);
      },
    },
    offscreen: {
      createDocument: async (arg) => {
        calls.offscreen.push(arg);
      },
      Reason: { USER_MEDIA: 'USER_MEDIA' },
    },
  };

  // The worker holds no reference to the stub, so mutating these mid-test is how
  // a test changes what the "page" reports, for instance to simulate the user
  // switching to a different video in the same tab.
  const answers = { describePayload, providePayload, trackPayload };

  /**
   * Resolve an answer, letting it depend on the request.
   *
   * The content script picks the track the worker ASKS for and only falls back to
   * a default when that track is missing. A stub that always returns the same
   * payload cannot tell those apart, it would report success for a language the
   * video does not have, and quietly turn a real bug into a passing test.
   *
   * Named `answerFor` rather than `resolve` because `resolve` here is
   * node:path's, which the dictionary fetch above depends on; shadowing it broke
   * the word list with an EISDIR.
   *
   * @param {any} payload
   * @param {object} request
   */
  function answerFor(payload, request) {
    return typeof payload === 'function' ? payload(request) : payload;
  }

  return {
    listeners,
    calls,
    storage,
    /**
     * The `chrome.storage` API itself, so a test can act as ANOTHER context,
     * writing to the bucket directly and firing the cross-context change event,
     * which is the only way to test that a live worker reacts to a change it did
     * not make.
     */
    chromeStorage: globalThis.chrome.storage,
    answers,
    /** Change what the content script reports from now on. */
    setAnswer(key, value) {
      answers[key] = value;
    },
  };
}

/**
 * A stand-in for the panel's end of the port, recording everything it is sent.
 *
 * @returns {{port: object, received: object[], sendFromPanel: (message: object) => void, disconnect: () => void}}
 */
export function createPanelPort() {
  const received = [];
  const messageHandlers = [];
  const disconnectHandlers = [];

  const port = {
    name: 'panel',
    postMessage: (message) => received.push(message),
    // Real ports expose an Event with both add and remove. The worker calls
    // removeListener when the port disconnects, so a stub without it throws
    // exactly where the real API would be used.
    onMessage: {
      addListener: (fn) => messageHandlers.push(fn),
      removeListener: (fn) => {
        const index = messageHandlers.indexOf(fn);
        if (index >= 0) messageHandlers.splice(index, 1);
      },
    },
    onDisconnect: { addListener: (fn) => disconnectHandlers.push(fn) },
  };

  return {
    port,
    received,
    sendFromPanel: (message) => {
      if (!messageHandlers.length) throw new Error('The worker never subscribed to the panel port.');
      for (const handler of [...messageHandlers]) handler({ ...message, target: 'background' });
    },
    /** Simulate the panel closing, so the worker has to cope with no listener. */
    disconnect: () => disconnectHandlers.forEach((fn) => fn()),
  };
}
