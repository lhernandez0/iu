/**
 * The smallest DOM the side panel needs, so it can be evaluated in Node.
 *
 * The panel is where the last bug lived: it called `chrome.runtime.connect`
 * once, at startup, and had no recovery path when that failed. Nothing short of
 * running the module catches that, so this stub exists to make running it
 * possible. It is deliberately dumb, a real DOM would hide the very mistakes
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
    this.style = new FakeStyle();
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.attributes = new Map();
    // Set through the backing field, NOT the setter: assigning would mark the
    // element as explicitly overridden, and a select would then never report
    // its selected option.
    this._value = '';
    this._valueOverride = false;
    this.disabled = false;
    this.hidden = false;
    this.title = '';
    this.type = '';
    this._text = '';
  }

  /**
   * An element with options reports the value of its selected one.
   *
   * The real `<select>` does this, and a stub that only keeps whatever `value`
   * was last assigned drifts from it: options are rebuilt on every state push,
   * so reading a select afterwards returns a stale value the browser would never
   * report. Anything depending on the selection, the swap carrying each
   * translation with its slot, for instance, then cannot be tested honestly.
   *
   * Keyed on having options rather than on `tagName`, because the fixture
   * creates every id as a plain element and never learns which are selects.
   *
   * Assignment still wins, since that is how a test simulates a user choice.
   */
  get value() {
    if (this._valueOverride) return this._value ?? '';
    const options = this.find((el) => el.tagName === 'OPTION');
    if (!options.length) return this._value ?? '';
    const selected = options.find((option) => option.selected);
    return String((selected ?? options[0]).value);
  }

  set value(next) {
    this._value = String(next ?? '');
    this._valueOverride = true;
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

  /**
   * Focus, recorded rather than performed.
   *
   * There is no focus model here, so the only thing worth modelling is WHICH
   * element the panel asked to focus, which is a real assertion: closing the
   * settings view must put focus back on the gear, or a keyboard user is left in
   * chrome that has just been hidden.
   */
  focus() {
    document.activeElement = this;
  }

  blur() {
    if (document.activeElement === this) document.activeElement = null;
  }

  /** @param {object} [options] */
  scrollIntoView() {
    // Layout is meaningless here.
  }

  /**
   * A `<select>` reports the value of its selected option.
   *
   * Without this the stub keeps whatever `value` was last assigned, so reading
   * a select after its options were rebuilt returns a stale value that the real
   * element would never report, and a test asserting on that passes or fails
   * for no reason connected to the code.
   *
   * @returns {string}
   */
  get selectedValue() {
    if (this.tagName !== 'SELECT') return this.value;
    const selected = this.find((el) => el.tagName === 'OPTION' && el.selected);
    if (selected.length) return String(selected[0].value);
    const first = this.find((el) => el.tagName === 'OPTION')[0];
    return first ? String(first.value) : '';
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

/** Inline styles, as much as the panel uses: setting a custom property. */
export class FakeStyle {
  constructor() {
    /** @type {Map<string, string>} */
    this.properties = new Map();
  }

  /** @param {string} name @param {string} value */
  setProperty(name, value) {
    this.properties.set(name, String(value));
  }

  /** @param {string} name */
  getPropertyValue(name) {
    return this.properties.get(name) ?? '';
  }
}
/**
 * Install the DOM and the browser globals the panel expects.
 *
 * @param {string[]} ids Element ids the panel will look up.
 * @param {{hidden?: string[]}} [options] Ids the real HTML starts hidden with the
 *   `hidden` attribute. Without this the stub would report them visible, and a
 *   test of anything that toggles one would be asserting the stub's default
 *   rather than the panel's behaviour.
 * @returns {{document: object, created: FakeElement[], byId: Map<string, FakeElement>}}
 */
export function installDomStub(ids = [], { hidden = [] } = {}) {
  const byId = new Map();
  for (const id of ids) {
    const element = new FakeElement('div');
    element.id = id;
    element.hidden = hidden.includes(id);
    byId.set(id, element);
  }

  /** Every element ever constructed, so a test can inspect what was rendered. */
  const created = [...byId.values()];

  // Text size is set as a custom property on the root, so the stub needs a root
  // to hang it on. It is not in `byId` because the panel reaches it through
  // `document.documentElement`, not by id.
  const documentElement = new FakeElement('html');
  created.push(documentElement);

  const document = {
    documentElement,
    /**
     * What currently has focus.
     *
     * A property rather than something computed, because the panel's use of focus
     * is a DECISION it makes (put focus back on the gear) rather than a behaviour
     * the DOM enforces, so recording it is enough to assert the decision.
     */
    activeElement: null,
    getElementById: (id) => byId.get(id) ?? null,
    /**
     * A class lookup, which the panel uses for the two REGIONS it hides as a unit
     *, the reading bar and the footer, because neither has an id.
     *
     * Handles only the simple `.class` form, and returns the first match. That is
     * deliberately narrow: a stub that pretended to be a selector engine would
     * pass tests for selectors the real one resolves differently, and the failures
     * that hides are exactly the ones a stub cannot catch.
     *
     * @param {string} selector
     */
    querySelector: (selector) => {
      const match = /^\.([\w-]+)$/.exec(selector);
      if (!match) return null;
      return created.find((el) => el instanceof FakeElement && el.classList?.contains(match[1])) ?? null;
    },
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

  /**
   * A text node, which `append` accepts and `textContent` reads through.
   *
   * **This was missing, and its absence made a stub report a bug that was not
   * there.** `renderTokens` emits a bare text node for a token it cannot define,
   * which is every punctuation mark in a Chinese transcript, so its absence meant
   * those characters vanished from `textContent`, and a test asserting the text of
   * a row came back empty while the real panel rendered it fine.
   */
  class FakeText {
    /** @param {string} data */
    constructor(data) {
      this.data = data;
    }

    get textContent() {
      return this.data;
    }
  }

  document.createTextNode = (data) => new FakeText(data);

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
