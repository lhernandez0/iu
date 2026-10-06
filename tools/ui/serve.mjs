/**
 * A preview server for the side panel: `npm run ui`.
 *
 * Why this exists. Iterating on the panel meant loading the extension in Chrome,
 * opening a YouTube video, and reading a live transcript — for every change to a
 * colour, a spacing, or a control. The states worth designing against (one
 * subtitle, nothing marked, a long silence, an error) were the hardest to reach
 * on demand. On top of that, reading a real transcript while working on the
 * layout is a licence problem, which is why `test/fixtures/` is local and
 * gitignored.
 *
 * None of that infrastructure is needed, though. The panel's entire contact with
 * the extension is `chrome.runtime.connect` returning a Port; every module it
 * imports is chrome-free. So it can be served as a plain page, with a fake Port,
 * and run the REAL panel — real stylesheet, real rendering, real controls —
 * against a mock worker and the committed synthetic corpus.
 *
 * What this does NOT do: it does not run the extension, the content scripts, the
 * real caption fetch, or the real marking. A layout proved here is a layout; a
 * fetch proved here is nothing. That is what `test/browser/` is for.
 *
 * Security note: this serves the repository over http with no authentication. It
 * is a local development tool and binds to the loopback address only.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, scenarioById } from './scenarios.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.IU_UI_PORT ?? 8099);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * The panel, plus the two things the preview adds.
 *
 * The extra script is a module the browser loads BEFORE the panel's own, so
 * `window.chrome` exists by the time the panel calls `connect`. It is injected
 * here rather than added to `sidepanel.html` because that file ships to users and
 * must not reference a development tool.
 *
 * @param {object} scenario
 * @returns {string}
 */
function panelHtml(scenario) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>IU preview — ${scenario.label}</title>
    <link rel="icon" href="/icons/icon-32.png" />
    <link rel="stylesheet" href="/src/sidepanel/sidepanel.css" />
    <link rel="stylesheet" href="/tools/ui/preview.css" />
  </head>
  <body>
    <header class="preview-bar">
      <span class="preview-title">Preview</span>
      ${SCENARIOS.map(
        (s) =>
          `<a class="preview-scenario${s.id === scenario.id ? ' on' : ''}" href="/?scenario=${s.id}" title="${s.note}">${s.label}</a>`,
      ).join('\n      ')}
    </header>

    <p class="preview-note">${scenario.note}</p>

    <!--
      The panel's own markup below this line is copied from
      src/sidepanel/sidepanel.html. It is duplicated because the preview must not
      change the shipped file, and because a preview that rendered different
      markup would be previewing a different panel.

      If you add a control there, add it here too — a missing control shows up as
      "Cannot read properties of null" in the console, which is loud enough to be
      obvious but not informative.
    -->
    <header class="bar">
      <div class="lang">
        <select id="study" aria-label="Language to learn"></select>
      </div>
      <button id="swap" type="button" title="Swap the two lines" aria-label="Swap the two lines">&#8646;</button>
      <div class="lang">
        <select id="gloss" aria-label="Second line, explaining the first"></select>
      </div>
    </header>

    <div id="gloss-options" class="gloss-options" hidden>
      <label class="translate-toggle">
        <input type="checkbox" id="gloss-translated" />
        Translate the second line into
      </label>
      <select id="translate-into" aria-label="Language to translate the second line into"></select>
    </div>

    <header class="bar learning">
      <select id="view-mode" aria-label="How much of the transcript to show"></select>
      <label class="size" title="Text size in pixels">
        <input id="font-size" type="number" min="10" max="32" step="1" aria-label="Text size in pixels" />
        <span class="size-unit">px</span>
      </label>
      <select id="list" aria-label="Word list"></select>
      <select id="threshold" aria-label="Highlight from level"></select>
    </header>

    <p id="status" class="status" role="status">Looking for a YouTube video…</p>

    <main id="transcript" class="transcript" aria-label="Transcript">
      <p class="empty">No transcript loaded.</p>
    </main>

    <footer class="bar">
      <label class="follow">
        <input type="checkbox" id="follow" checked />
        Follow
      </label>
      <button id="copy" type="button">Copy</button>
      <select id="format" class="format" aria-label="Export format">
        <option value="txt">.txt</option>
        <option value="srt">.srt</option>
      </select>
      <button id="save" type="button">Save</button>
    </footer>

    <script type="module">
      import { installMockChrome } from '/tools/ui/mock-worker.mjs';

      // The scenario is embedded as DATA, not imported.
      //
      // Importing it would pull in the corpus loader, which reads files from
      // disk — the browser then tries to fetch a Node builtin, CORS blocks it,
      // and the panel sits on its placeholder with the reason buried in the
      // console.
      const scenario = ${JSON.stringify(scenario)};

      const { worker } = installMockChrome(scenario);

      // Overrides for reviewing a specific state, applied from the URL so a
      // layout can be linked to and reloaded rather than rebuilt by clicking.
      // e.g. ?scenario=bilingual&view=focus&fontSize=22
      const params = new URLSearchParams(location.search);
      const patch = {};
      if (params.has('view')) patch.view = params.get('view');
      if (params.has('fontSize')) patch.fontSize = Number(params.get('fontSize'));
      if (params.has('threshold')) patch.threshold = Number(params.get('threshold'));
      for (const [id, value] of Object.entries(patch)) {
        worker.port.received({ type: 'set-setting', id, value, target: 'background' });
      }

      // The panel loads after this, as the last module, so window.chrome is
      // installed by the time the panel calls connect.
      await import('/src/sidepanel/sidepanel.js');
      worker.start();
    </script>
  </body>
</html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const scenario = scenarioById(url.searchParams.get('scenario'));
    response.writeHead(200, { 'content-type': TYPES['.html'] });
    response.end(panelHtml(scenario));
    return;
  }

  // Everything else is a file from the repository. The path is resolved and then
  // checked to be inside the root, so `../` cannot walk out of the project.
  const wanted = resolve(ROOT, `.${normalize(url.pathname)}`);
  if (!wanted.startsWith(ROOT)) {
    response.writeHead(403).end('outside the project');
    return;
  }

  try {
    const body = await readFile(wanted);
    response.writeHead(200, { 'content-type': TYPES[extname(wanted)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end(`not found: ${url.pathname}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  IU side panel preview`);
  console.log(`  http://127.0.0.1:${PORT}\n`);
  console.log('  Scenarios:');
  for (const scenario of SCENARIOS) console.log(`    ${scenario.id.padEnd(16)} ${scenario.label}`);
  console.log('\n  ?scenario=<id>&view=focus&fontSize=22&threshold=2\n');
  console.log('  This renders the real panel against a mock worker. It does not');
  console.log('  exercise the content scripts, the caption fetch, or the marking.\n');
});
