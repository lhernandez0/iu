/**
 * The smallest DOM the side panel needs, so it can be evaluated in Node.
 *
 * The panel is where the last bug lived: it called `chrome.runtime.connect`
 * once, at startup, and had no recovery path when that failed. Nothing short of
 * running the module catches that, so this stub exists to make running it
 * possible. It is deliberately dumb — a real DOM would hide the very mistakes
 * worth catching (an element that does not exist, a listener never registered).
 *
 * Anything the panel touches but this does not implement will throw, loudly,
 * which is the right outcome: it means the panel reached for something new.
 */

class FakeClassList {
  constructor() {
    this.classes = new Set();
  }
  add(name) {
    this.classes.add(name);
  }
  remove(name) {
    this.classes.delete(name);
  }
  toggle(name, force) {
    if (force === undefined) force = !this.classes.has(name);
    if (force) this.classes.add(name);
    else this.classes.delete(name);
    return force;
  }
  contains(name) {
    return this.classes.has(name);
  }
}

export class FakeElement {
  /** @param {string} tag */
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.title = '';
    this.type = '';
    this._text = '';
  }

  // `className` and `classList` are two views of one thing in the real DOM, so
  // they have to stay in step here too. Assigning `className` and then finding
  // nothing with `classList.contains(...)` was a stub bug that made a passing
  // product look broken.
  get className() {
    return [...this.classList.classes].join(' ');
  }

  set className(value) {
    this.classList = new FakeClassList();
    for (const name of String(value).split(/\s+/).filter(Boolean)) this.classList.add(name);
  }

  // As in the real DOM: setting textContent replaces children, and reading it
  // concatenates the subtree.
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((child) => child.textContent ?? '').join('');
  }

  set textContent(value) {
    this._text = value === null || value === undefined ? '' : String(value);
    this.children = [];
  }

  /**
   * @param {string} type
   * @param {Function} handler
   */
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  /**
   * @param {string} type
   * @param {object} [event]
   */
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ target: this, ...event });
  }

  /** @param {...any} nodes */
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeFragment) this.children.push(...node.children);
      else {
        this.children.push(node);
        if (node instanceof FakeElement) node.parent = this;
      }
    }
  }

  /** @param {...any} nodes */
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** @param {object} [options] */
  scrollIntoView() {
    // Layout is meaningless here.
  }

  /**
   * Every descendant matching a predicate.
   *
   * @param {(element: FakeElement) => boolean} predicate
   * @returns {FakeElement[]}
   */
  find(predicate) {
    const found = [];
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (predicate(child)) found.push(child);
      found.push(...child.find(predicate));
    }
    return found;
  }
}

export class FakeFragment extends FakeElement {
  constructor() {
    super('fragment');
  }
}

/**
 * Install the DOM and the browser globals the panel expects.
 *
 * @param {string[]} ids Element ids the panel will look up.
 * @returns {{document: object, created: FakeElement[], byId: Map<string, FakeElement>}}
 */
export function installDomStub(ids = []) {
  const byId = new Map();
  for (const id of ids) {
    const element = new FakeElement('div');
    element.id = id;
    byId.set(id, element);
  }

  /** Every element ever constructed, so a test can inspect what was rendered. */
  const created = [...byId.values()];

  const document = {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => {
      const element = new FakeElement(tag);
      created.push(element);
      return element;
    },
    createDocumentFragment: () => {
      const fragment = new FakeFragment();
      created.push(fragment);
      return fragment;
    },
  };

  // `new Option(label, value)` is how the panel builds its dropdowns.
  class FakeOption extends FakeElement {
    constructor(text = '', value = '') {
      super('option');
      this.text = text;
      this.value = value;
      this.selected = false;
      created.push(this);
    }
  }

  globalThis.document = document;
  globalThis.Option = FakeOption;

  // Node 26 exposes `navigator` as a getter-only global, so assigning to it
  // throws. Defining the property is the portable way to replace it.
  define('navigator', { clipboard: { writeText: async () => {} } });
  define('Blob', class Blob {
    constructor(parts) {
      this.parts = parts;
    }
  });
  // The panel uses these only to trigger a download of the export.
  define('URL', { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} });
  define('setTimeout', globalThis.setTimeout);

  return { document, created, byId };
}

/**
 * @param {string} name
 * @param {any} value
 */
function define(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

/**
 * A stand-in for `chrome.runtime.connect`'s port, plus the runtime surface the
 * panel uses.
 *
 * @param {{failWith?: string}} [options] `failWith` makes `connect` throw, which
 *   is what an invalidated extension context does.
 * @returns {{chrome: object, ports: object[], lastErrorRead: () => boolean, ...}}
 */
export function installChromeStubForPanel({ failWith = null } = {}) {
  /** Every port the panel has opened, in order. */
  const ports = [];
  let lastErrorWasRead = false;

  const runtime = {
    connect: (info) => {
      if (failWith) throw new Error(failWith);

      const port = {
        name: info?.name,
        /** What the panel sent. */
        sent: [],
        disconnected: [],
        listeners: { message: [], disconnect: [] },
        onMessage: { addListener: (fn) => port.listeners.message.push(fn) },
        onDisconnect: { addListener: (fn) => port.listeners.disconnect.push(fn) },
        postMessage: (message) => port.sent.push(message),
        /** Simulate the worker sending something down the port. */
        emit: (message) => port.listeners.message.forEach((fn) => fn(message)),
        /** Simulate the worker going away. */
        drop: (message = 'the worker stopped') => {
          // Chrome exposes the reason here, and *reading it* is what clears the
          // "Unchecked runtime.lastError" warning. That is why this is a getter.
          Object.defineProperty(runtime, 'lastError', {
            configurable: true,
            get() {
              lastErrorWasRead = true;
              return { message };
            },
          });
          port.listeners.disconnect.forEach((fn) => fn());
        },
      };
      ports.push(port);
      return port;
    },
    lastError: undefined,
    id: 'test-extension',
  };

  globalThis.chrome = { runtime };

  return {
    chrome: globalThis.chrome,
    ports,
    lastErrorRead: () => lastErrorWasRead,
    lastPort: () => ports.at(-1) ?? null,
  };
}
