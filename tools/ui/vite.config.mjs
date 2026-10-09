/**
 * Vite config for the side panel preview (`npm run ui`).
 *
 * Vite, not Storybook: this is one 57-line panel, not a component library. What
 * was actually needed was a dev server with hot module replacement — so a
 * stylesheet edit lands in the browser without a reload — and a build tool that
 * understands the panel's ES modules. Storybook would have brought an isolated
 * component model this does not have components for.
 *
 * Root is the REPOSITORY, not `tools/ui/`, so the page can import the panel by
 * the same paths the extension uses (`/src/sidepanel/sidepanel.js`). Serving the
 * real file paths is what keeps the preview honest — a bad import here is a bad
 * import in the extension.
 *
 * DEVELOPMENT ONLY. Vite cannot serve a `chrome-extension://` page, so this is a
 * preview and not a test of the extension: `test/browser/iu.browser.test.mjs`
 * loads the real thing. Nothing here is part of the shipped extension, and none of
 * it is needed by `npm test`.
 *
 * Deliberately short. Options that were not needed were removed rather than
 * written down "in case" — a config nobody has verified is a config that can be
 * wrong without anyone noticing.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import { SCENARIO_INDEX, scenarioById } from './scenarios.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.IU_UI_PORT ?? 8099);

/**
 * Serve the scenarios as data.
 *
 * The scenarios read the synthetic corpus from disk, so the browser cannot import
 * them: it would try to fetch the filesystem and fail with a CORS message that
 * says nothing about the cause. A dev-server endpoint is the right home — it runs
 * in Node, and the page fetches the result.
 *
 * This is the one piece of server behaviour the preview needs. Everything else —
 * module resolution, CSS injection, HMR — is why Vite is here instead of a
 * hand-written server.
 *
 * @returns {import('vite').Plugin}
 */
function scenariosPlugin() {
  const json = (res, body) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };

  return {
    name: 'iu-scenarios',
    configureServer(server) {
      server.middlewares.use('/api/scenario-index', (_req, res) => json(res, SCENARIO_INDEX));
      server.middlewares.use('/api/scenario', (req, res) => {
        const id = new URL(req.url, 'http://localhost').searchParams.get('scenario');
        json(res, scenarioById(id));
      });
    },
  };
}

/**
 * Give media files the content type their extension implies.
 *
 * **Vite's static server does not know `.mkv`, and serves it with an EMPTY
 * `Content-Type`.** Chromium then refuses to decode it and reports `media error 4`
 * (`SRC_NOT_SUPPORTED`) with `net::ERR_ABORTED` — a failure that reads as a codec
 * problem and is not one. `canPlayType('video/x-matroska; codecs="avc1..."')`
 * answers "probably" throughout, which makes the wrong diagnosis very convincing.
 *
 * The player preview plays a real 31MB sample from `test/conformance/`, so this
 * has to be right or the preview cannot start at all.
 *
 * @returns {import('vite').Plugin}
 */
function mediaTypesPlugin() {
  const TYPES = new Map([
    ['.mkv', 'video/x-matroska'],
    ['.mp4', 'video/mp4'],
    ['.m4v', 'video/mp4'],
    ['.webm', 'video/webm'],
    ['.mov', 'video/quicktime'],
    ['.ogv', 'video/ogg'],
    ['.srt', 'text/plain; charset=utf-8'],
    ['.vtt', 'text/vtt; charset=utf-8'],
    ['.ass', 'text/plain; charset=utf-8'],
    ['.ssa', 'text/plain; charset=utf-8'],
  ]);

  return {
    name: 'iu-media-types',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        const dot = path.lastIndexOf('.');
        const type = dot === -1 ? undefined : TYPES.get(path.slice(dot).toLowerCase());
        // Set only, never override: an extension that IS known to Vite already has
        // a correct type, and this must not second-guess it.
        if (type && !res.getHeader('Content-Type')) res.setHeader('Content-Type', type);
        next();
      });
    },
  };
}

export default defineConfig({
  root: ROOT,
  plugins: [scenariosPlugin(), mediaTypesPlugin()],
  server: {
    port: PORT,
    // Loopback only. This serves the repository with no authentication, so it
    // must not be reachable from the network.
    host: '127.0.0.1',
    // Vite prints the URL rather than launching anything. `open: true` tries to
    // spawn a system browser, which in a remote or headless session fails with a
    // message that looks like the server is broken. The URL is right there in the
    // output, and it is the same URL every time.
    open: false,
  },
});
