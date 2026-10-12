/**
 * Build the GitHub Pages demo: the shipped viewer, on a normal web page.
 *
 *   node tools/pages/build.mjs                # into build/pages
 *   node tools/pages/build.mjs --out <dir>
 *
 * ## What this produces, and what it does not change
 *
 * `build/pages/` holds `src/` **copied verbatim** plus a small demo page, so the
 * demo runs the SHIPPED viewer rather than a fork of it. That distinction is the
 * whole value: a demo built from a copy proves nothing about what people install,
 * and would drift from it silently.
 *
 * Nothing under `src/` is rewritten. The three rewrites in the generated page are
 * all relative-path fixes for the extra directory level, not behaviour.
 *
 * ## Why it is generated rather than committed
 *
 * `build/` is gitignored, and the deployed artifact is assembled by CI. A committed
 * copy of `src/` would be a second source of truth, which is the failure mode this
 * repository has already been bitten by twice: the `japanese.json` gloss drift and
 * the `defaultThreshold` field that a rebuild silently dropped.
 */

import { readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');

const outArg = process.argv.indexOf('--out');
const OUT = outArg === -1 ? resolve(ROOT, 'build/pages') : resolve(process.argv[outArg + 1]);

/**
 * The media the demo opens, if it is present.
 *
 * Read from a directory the build does NOT own, so the choice of content is a
 * deployment decision rather than a code change. Absent is fine: the page then
 * shows the viewer's own empty state, which is a truthful demo of an empty page and
 * still proves the shim works.
 *
 * The name is fixed so the page does not have to be regenerated when the film is
 * swapped, which matters because regenerating means redeploying.
 */
const MEDIA_DIR = resolve(ROOT, 'tools/pages/media');
const VIDEO_NAMES = ['demo.mkv', 'demo.mp4', 'demo.webm'];
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'];

/** @param {string[]} names @returns {string|null} */
function firstPresent(names) {
  for (const name of names) {
    const path = join(MEDIA_DIR, name);
    if (existsSync(path)) return name;
  }
  return null;
}

/**
 * Every subtitle file in the media directory, sorted.
 *
 * ALL of them, not one: the point of the demo is the two-line study view, and that
 * only shows something with at least two tracks in DIFFERENT languages. Loading a
 * single subtitle would leave Line 2 offering nothing but "Off".
 *
 * Sorted so the build is reproducible, and so English (whose name sorts first) is
 * the track the viewer picks by default.
 *
 * @returns {string[]}
 */
function subtitleNames() {
  if (!existsSync(MEDIA_DIR)) return [];
  return readdirSync(MEDIA_DIR)
    .filter((name) => SUBTITLE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)))
    .sort();
}

/**
 * The demo page: `viewer.html` with three paths fixed and one script swapped.
 *
 * Rewritten by REPLACEMENT rather than re-authored, so the markup, the labels, the
 * accessibility attributes and any future change to `viewer.html` all carry through.
 * A hand-written demo page would be a second copy of 400 lines of markup, and the
 * two would diverge the first time somebody adjusted a control.
 *
 * @param {string} viewerHtml
 * @param {{video: string|null, subtitles: string[]}} media
 * @returns {string}
 */
function demoPage(viewerHtml, media) {
  let html = viewerHtml;

  // `viewer.html` sits at `src/viewer/`, and a relative href there means "sibling
  // of this file". The demo page sits at the root, so the same files are one level
  // further down. Matching on the exact attribute text keeps this from touching
  // anything else.
  const rewrites = [
    ['href="../common/marks.css"', 'href="src/common/marks.css"'],
    ['href="viewer.css"', 'href="src/viewer/viewer.css"'],
  ];
  for (const [from, to] of rewrites) {
    if (!html.includes(from)) {
      // A rename in `viewer.html` would otherwise produce a page that silently
      // loads no stylesheet and still "works", which looks like a CSS bug.
      throw new Error(`the demo page could not find ${JSON.stringify(from)} in src/viewer/viewer.html`);
    }
    html = html.replace(from, to);
  }

  // The entry point does two things the shipped page's script cannot: install the
  // shim first, then run the viewer. See `demo-entry.js`.
  const script = '<script type="module" src="viewer.js"></script>';
  if (!html.includes(script)) {
    throw new Error('the demo page could not find the viewer script tag');
  }
  html = html.replace(script, '<script type="module" src="demo-entry.js"></script>');

  // The loader. A module, and it runs after the demo entry so the viewer is ready
  // to receive files. Kept in the page rather than in a file so the media names
  // travel with the markup that references them.
  const loader = `
    <script type="module">
      // Open the bundled media automatically, so the page is a demonstration
      // rather than an empty player with a file picker.
      //
      // The files are handed to the input through a DataTransfer, which is the same
      // thing a drag-and-drop does, so this goes through the viewer's REAL path
      // rather than a private hook. The viewer exports nothing to call, and adding
      // an export only for the demo would put demo-shaped code in the product.
      const video = ${JSON.stringify(media.video)};
      const subtitles = ${JSON.stringify(media.subtitles)};

      if (video || subtitles.length) {
        const input = document.getElementById('pick-files');
        const transfer = new DataTransfer();

        for (const name of [video, ...subtitles]) {
          if (!name) continue;
          // Fetched as a blob rather than linked, because the viewer takes File
          // objects: it reads the bytes to parse the container, and a URL would make
          // it a streaming video with no file to inspect.
          const response = await fetch(name);
          if (!response.ok) continue;
          const blob = await response.blob();
          transfer.items.add(new File([blob], name, { type: blob.type }));
        }

        if (transfer.items.length) {
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    </script>
  `;
  html = html.replace('</body>', `${loader}\n  </body>`);

  return html;
}

async function main() {
  const viewerHtml = await readFile(resolve(ROOT, 'src/viewer/viewer.html'), 'utf8');
  const video = firstPresent(VIDEO_NAMES);
  const subtitles = subtitleNames();

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // `src/` verbatim, INCLUDING the vendored bundle.
  //
  // An earlier version filtered `mediabunny.js` out to save 436 KB, on the theory
  // that the demo would not need it. That was wrong and the browser said so: the
  // viewer imports it to read the MKV and MP4 containers, so excluding it produced
  // a 404 on load and a viewer that could not open the very file the demo exists to
  // show. The saving was not worth a broken feature, and the failure only appeared
  // in a real page, not in any check.
  await cp(resolve(ROOT, 'src'), join(OUT, 'src'), { recursive: true });

  // The two shim files, next to the page that imports them. Copied as FILES rather
  // than moving the directory, so nothing under `tools/` is published: only these
  // two are reachable from the page.
  //
  // Their imports are REWRITTEN rather than copied verbatim, and the reason is the
  // deployment: GitHub Pages serves a project site from `/iu/`, not from the domain
  // root, so a root-absolute `import '/src/viewer/viewer.js'` resolves to
  // `https://<user>.github.io/src/...`, one level ABOVE the site, and 404s.
  //
  // `'/src/` becomes `'./src/`, NOT `'src/`. Both drop the leading slash, but only
  // the `./` form stays a RELATIVE specifier: a bare `src/viewer/viewer.js` is
  // treated as a package name, is not resolvable from a page, and throws a module
  // error before the shim ever runs. That mistake was made here once already and the
  // only symptom was a blank page with no network activity for the missing file.
  for (const name of ['demo-entry.js', 'chrome-shim.js']) {
    const source = await readFile(join(here, name), 'utf8');
    // Only the QUOTED form, so a comment mentioning the path is left alone. If the
    // anchor ever stops matching, fail loudly: silently shipping the absolute form
    // is the failure this exists to prevent.
    if (!source.includes("'/src/")) {
      throw new Error(`${name} no longer imports with a root-absolute '/src/ path; update this rewrite`);
    }
    await writeFile(join(OUT, name), source.replaceAll("'/src/", "'./src/"), 'utf8');
  }

  await writeFile(join(OUT, 'index.html'), demoPage(viewerHtml, { video, subtitles }), 'utf8');

  if (video) {
    const bytes = (await stat(join(MEDIA_DIR, video))).size;
    await cp(join(MEDIA_DIR, video), join(OUT, video));
    console.log(`  media: ${video} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    console.log('  media: none, the page will show the viewer\'s empty state');
  }
  for (const name of subtitles) await cp(join(MEDIA_DIR, name), join(OUT, name));
  console.log(`  subtitles: ${subtitles.length ? subtitles.join(', ') : 'none'}`);
  console.log(`wrote ${OUT}`);
}

await main();
