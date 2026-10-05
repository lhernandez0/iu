/**
 * Minimal stand-in for the `chrome.*` surface the service worker touches.
 *
 * The extension cannot be loaded in Node, but the worker is plain ES modules
 * and its only contact with the browser is the `chrome` global. Stubbing that
 * is enough to actually evaluate the module, which catches a whole class of
 * failure that static checks cannot: anything thrown at module scope. A worker
 * that throws while loading never answers the panel, and the panel just sits on
 * its placeholder — indistinguishable, from the panel's side, from a slow
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
 * @param {any} [options.providePayload]   What the content script "returns" for PROVIDE.
 * @param {any} [options.trackPayload]     What it returns for FETCH_TRACK.
 * @returns {{listeners: object, calls: object, storage: object}}
 */
export function installChromeStub(options = {}) {
  const {
    tabs = [{ id: 1, active: true, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
    frames = [{ frameId: 0, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
    providePayload = null,
    trackPayload = null,
  } = options;

  /** Registrations, so a test can fire the events the browser would. */
  const listeners = {
    message: [],
    connect: [],
    tabActivated: [],
    tabRemoved: [],
    actionClicked: [],
  };

  /** Everything the worker asked the browser to do. */
  const calls = { executeScript: [], sendMessage: [], sidePanelOpen: [], offscreen: [] };

  const storage = {};

  const addListener = (bucket) => (fn) => listeners[bucket].push(fn);

  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: addListener('message') },
      onConnect: { addListener: addListener('connect') },
      onInstalled: { addListener: () => {} },
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      // The worker broadcasts to the offscreen document over this; nothing
      // is listening in a test, so a resolved promise is the honest answer.
      sendMessage: async (message) => {
        calls.sendMessage.push(message);
        return { ok: true };
      },
    },
    tabs: {
      onActivated: { addListener: addListener('tabActivated') },
      onRemoved: { addListener: addListener('tabRemoved') },
      query: async (query) => tabs.filter((t) => query?.active === undefined || t.active === query.active),
      get: async (id) => tabs.find((t) => t.id === id) ?? null,
      sendMessage: async (tabId, message, frameOptions) => {
        calls.sendMessage.push({ tabId, message, frameOptions });
        if (message?.type === 'provide') return providePayload;
        if (message?.type === 'fetch-track') return trackPayload;
        return { ok: true };
      },
    },
    webNavigation: { getAllFrames: async () => frames },
    scripting: {
      executeScript: async (arg) => {
        calls.executeScript.push(arg);
        return [];
      },
    },
    storage: {
      local: {
        get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (items) => Object.assign(storage, items),
      },
    },
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

  return { listeners, calls, storage };
}

/**
 * A stand-in for the panel's end of the port, recording everything it is sent.
 *
 * @returns {{port: object, received: object[], sendFromPanel: (message: object) => void}}
 */
export function createPanelPort() {
  const received = [];
  /** @type {((message: object) => void) | null} */
  let handler = null;

  const port = {
    name: 'panel',
    postMessage: (message) => received.push(message),
    onMessage: { addListener: (fn) => (handler = fn) },
    onDisconnect: { addListener: () => {} },
  };

  return {
    port,
    received,
    sendFromPanel: (message) => {
      if (!handler) throw new Error('The worker never subscribed to the panel port.');
      handler({ ...message, target: 'background' });
    },
  };
}
