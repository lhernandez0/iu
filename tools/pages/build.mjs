/**
 * Build the GitHub Pages demo: the shipped viewer, on a normal web page.
 *
 *   node tools/pages/build.mjs                  # into build/pages
 *   node tools/pages/build.mjs --out <dir>
 *   node tools/pages/build.mjs --force-offer    # show the offer off GitHub Pages
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
 * ## `--force-offer`, and why it exists
 *
 * The sample-video offer is gated to a `*.github.io` host, because the media only
 * exists on the deployed site. That gate makes the offer invisible in local
 * development, so there was no way to LOOK at it before shipping, which is exactly
 * the situation `--force-offer` fixes: it drops the host check for one build so the
 * offer can be reviewed at `127.0.0.1`. The served artifact still carries the gate,
 * because this flag changes the build, not the page.
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
 * Whether to skip the GitHub Pages host check so the offer can be previewed
 * locally. See the note in the module docstring.
 */
const FORCE_OFFER = process.argv.includes('--force-offer');

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

  // The demo offer, placed INSIDE the viewer's empty state.
  //
  // Not a floating button in the corner, which was tried and read as a stray
  // control. The empty state is already the viewer asking what you want to open,
  // so this continues that sentence: the hint, then one line offering the sample
  // and naming it.
  //
  // The name is deliberately terse. An earlier version put the licence, the source
  // and a note about the encoding behind a `?`, which read as a lecture under a
  // file picker. Director and year is what identifies a film; the rest belongs in
  // THIRD-PARTY.md, where a reader looking for provenance finds it.
  //
  // The rules it must not break:
  //   - `.placeholder` is `pointer-events: none`, so this sets `auto` on itself.
  //   - `.bar` auto-hides on pointer idle, so nothing demo-shaped may live there.
  //   - HIDDEN unless the media exists AND the page is on GitHub Pages (see the
  //     loader). Built locally there is no `tools/pages/media/`, so an offer would
  //     fetch a 404 and sit there doing nothing.
  const offer = `
        <p class="placeholder-hint" id="demo-offer" hidden>
          or
          <button type="button" class="link-button" id="demo-load">open the sample video</button>
          <span class="demo-credit">Princess Iron Fan (1941), dir. Wan Laiming and Wan Guchan</span>
        </p>
  `;
  // Injected as the last child of the placeholder, so it sits under the existing
  // hint text. The anchor is the closing tag rather than a line, so a change to the
  // surrounding markup cannot silently move it somewhere else.
  const placeholderEnd = '</div>\n\n        <!--\n          The captions, floating over the bottom of the picture.';
  if (!html.includes(placeholderEnd)) {
    throw new Error('the demo could not find the end of the viewer placeholder; update this anchor');
  }
  html = html.replace(placeholderEnd, `${offer}        </div>\n\n        <!--\n          The captions, floating over the bottom of the picture.`);

  const loader = `
    <script type="module">
      // The demo media, only on the published site.
      //
      // The check is on the hostname rather than a build-time flag, so the SAME
      // artifact works either way and there is no "which build is this" question.
      // GitHub Pages serves project sites from \`<user>.github.io\`, so the suffix
      // test is exact for that host and false for \`127.0.0.1\`, \`localhost\` and a
      // \`file://\` page alike.
      const onPages = ${FORCE_OFFER ? 'true /* --force-offer: review build only */' : "location.hostname.endsWith('.github.io')"};
      const offer = document.getElementById('demo-offer');
      const button = document.getElementById('demo-load');
      const video = ${JSON.stringify(media.video)};
      const subtitles = ${JSON.stringify(media.subtitles)};

      // No media bundled, or not on Pages: leave the offer hidden and the page
      // empty. Checked against the ACTUAL files rather than assumed, because a
      // local build has none and an offer that 404s is worse than no offer.
      if (onPages && (video || subtitles.length)) {
        offer.hidden = false;

        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = 'Loading…';
          try {
            // Handed to the input through a DataTransfer, which is the same thing a
            // drag-and-drop does, so this goes through the viewer's REAL path rather
            // than a private hook. The viewer exports nothing to call, and adding an
            // export only for the demo would put demo-shaped code in the product.
            const input = document.getElementById('pick-files');
            const transfer = new DataTransfer();

            for (const name of [video, ...subtitles]) {
              if (!name) continue;
              // Fetched as a blob rather than linked, because the viewer takes File
              // objects: it reads the bytes to parse the container, and a URL would
              // make it a streaming video with no file to inspect.
              const response = await fetch(name);
              if (!response.ok) continue;
              const blob = await response.blob();
              transfer.items.add(new File([blob], name, { type: blob.type }));
            }

            if (!transfer.items.length) throw new Error('nothing loaded');

            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            // Kept, not hidden: pressing it again re-opens the sample after you
            // have replaced it with your own file, which is the obvious thing to
            // want and what an auto-open timer could never do.
            button.textContent = 'Open the sample video';
            button.disabled = false;
          } catch (error) {
            button.textContent = 'Could not load the sample';
            button.disabled = false;
            console.error('the demo media could not be loaded', error);
          }
        });
      }
    </script>
  `;
  html = html.replace('</body>', `${loader}\n  </body>`);

  // A small stylesheet for the offer. In the page because it styles the demo
  // chrome, not the viewer, and putting it in `viewer.css` would put demo styling
  // in the shipping artifact.
  //
  // The `auto` on `#demo-offer` is load bearing: `.placeholder` sets
  // `pointer-events: none` so it never swallows clicks meant for the picture, and
  // that is inherited, so the button is unclickable without this.
  const style = `
    <style>
      #demo-offer {
        pointer-events: auto;
      }
      /* The offer reads as a continuation of the hint above it, so it inherits that
         line's muted colour and size. Not a call to action in a box: the empty
         state should look like the viewer, plus one sentence. */
      #demo-offer .link-button {
        padding: 0;
        border: 0;
        background: none;
        color: var(--accent);
        font: inherit;
        text-decoration: underline;
        text-underline-offset: 2px;
        cursor: pointer;
      }
      #demo-offer .link-button:hover { color: #fff; }
      #demo-offer .link-button:disabled { color: var(--muted); cursor: default; text-decoration: none; }

      /* The film's name, quieter than the offer beside it and on its own line, so it
         reads as a caption rather than as part of the sentence. */
      .demo-credit {
        display: block;
        margin-top: 6px;
        font-size: 12px;
        opacity: 0.75;
      }
    </style>
  `;
  html = html.replace('</head>', `${style}\n  </head>`);

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
