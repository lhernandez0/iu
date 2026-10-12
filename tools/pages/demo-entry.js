/**
 * The demo page's entry point: install the shim, then run the real viewer.
 *
 * Two imports in a deliberate order, and the order is the whole file. ES modules
 * evaluate their dependencies before their own body, and dependencies evaluate in
 * the order they are listed, so `chrome-shim.js` has run by the time `viewer.js`
 * starts. The viewer reads `globalThis.browser ?? globalThis.chrome` at its module
 * scope, so a shim imported after it would be too late and the page would throw on
 * the first `api.storage` call.
 *
 * Writing this as one import of a file that imports both would NOT be equivalent:
 * the dependency graph would decide, not the source order.
 *
 * The viewer is the SHIPPED file, unmodified. That is the point of the shim: a demo
 * that runs a fork proves nothing about what people install.
 */

import './chrome-shim.js';
import '/src/viewer/viewer.js';
