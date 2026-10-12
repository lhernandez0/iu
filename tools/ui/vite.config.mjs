/**
 * Vite config for the side panel preview (`npm run ui`).
 *
 * Vite, not Storybook: this is one 57-line panel, not a component library. What
 * was actually needed was a dev server with hot module replacement, so a
 * stylesheet edit lands in the browser without a reload, and a build tool that
 * understands the panel's ES modules. Storybook would have brought an isolated
 * component model this does not have components for.
 *
 * Root is the REPOSITORY, not `tools/ui/`, so the page can import the panel by
 * the same paths the extension uses (`/src/sidepanel/sidepanel.js`). Serving the
 * real file paths is what keeps the preview honest, a bad import here is a bad
 * import in the extension.
 *
 * DEVELOPMENT ONLY. Vite cannot serve a `chrome-extension://` page, so this is a
 * preview and not a test of the extension: `test/browser/iu.browser.test.mjs`
 * loads the real thing. Nothing here is part of the shipped extension, and none of
 * it is needed by `npm test`.
 *
 * Deliberately short. Options that were not needed were removed rather than
 * written down "in case", a config nobody has verified is a config that can be
 * wrong without anyone noticing.
 */

import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';
import { defineConfig } from 'vite';
import { SCENARIO_INDEX, scenarioById } from './scenarios.mjs';

const run = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.IU_UI_PORT ?? 8099);

/**
 * Serve the GitHub Pages demo at `/pages-demo/`.
 *
 * **Why this exists.** The demo page gates its sample-video offer to a
 * `*.github.io` host, because the media only exists on the deployed site. Correct
 * behaviour, and it made the offer invisible in local development, so there was no
 * way to LOOK at the thing before shipping it. A screenshot is not a way to
 * develop: you cannot hover the `?`, tab through it, or check it at your own window
 * size.
 *
 * So the dev server BUILDS the demo with `--force-offer` (blanking the host check
 * for review) into a temp directory, and serves it from a path prefix. Relative
 * paths inside the build resolve against that prefix, which is also how GitHub
 * Pages serves it, so this reproduces the deployed layout rather than approximating
 * it.
 *
 * The build runs ONCE on server start rather than per request: resolving every
 * request would re-copy 31 MB. Restart `npm run ui` after changing `build.mjs`, or
 * the page source, which is the same rule as any other generated artifact here.
 *
 * Deliberately a middleware rather than a checked-in copy of the page: a second
 * copy would drift from the build, and this repository has been bitten by exactly
 * that twice (`japanese.json`, `defaultThreshold`).
 *
 * @returns {import('vite').Plugin}
 */
function pagesDemoPlugin() {
  const OUT = resolve(ROOT, 'build', 'pages-preview');
  /** Built lazily on the first request, then reused. */
  let building = null;

  const build = () => {
    building ??= run(process.execPath, ['tools/pages/build.mjs', '--force-offer', '--out', OUT], {
      cwd: ROOT,
    }).then(() => {
      console.log(`\n  pages demo:  http://127.0.0.1:${PORT}/pages-demo/\n`);
    });
    return building;
  };

  return {
    name: 'iu-pages-demo',
    async configureServer(server) {
      // Built before the banner prints so the URL is live when the server is.
      await build().catch((error) => {
        // Not fatal: the other preview pages still work, and this prints why.
        console.error(`\n  pages demo build failed, /pages-demo/ will 500:\n${error.stderr ?? error}\n`);
      });

      server.middlewares.use('/pages-demo', async (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const target = join(OUT, rel === '/' ? 'index.html' : rel);

        // Never escape the build directory, whatever the request says.
        if (!target.startsWith(OUT)) return next();

        try {
          const info = await stat(target);
          if (!info.isFile()) return next();
          const body = await readFile(target);
          res.setHeader('content-type', TYPE_BY_EXTENSION.get(extname(target)) ?? 'application/octet-stream');
          // `no-store`, because the whole point is reviewing the CURRENT build.
          res.setHeader('cache-control', 'no-store');
          res.end(body);
        } catch {
          next();
        }
      });
    },
  };
}

/** Content types for what the demo serves, including the ones Vite does not know. */
const TYPE_BY_EXTENSION = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.webm', 'video/webm'],
  ['.srt', 'text/plain; charset=utf-8'],
  ['.vtt', 'text/vtt; charset=utf-8'],
]);

/**
 * Serve the scenarios as data.
 *
 * The scenarios read the synthetic corpus from disk, so the browser cannot import
 * them: it would try to fetch the filesystem and fail with a CORS message that
 * says nothing about the cause. A dev-server endpoint is the right home, it runs
 * in Node, and the page fetches the result.
 *
 * This is the one piece of server behaviour the preview needs. Everything else,
 * module resolution, CSS injection, HMR, is why Vite is here instead of a
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
 * (`SRC_NOT_SUPPORTED`) with `net::ERR_ABORTED`, a failure that reads as a codec
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
  plugins: [scenariosPlugin(), mediaTypesPlugin(), pagesDemoPlugin()],
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
