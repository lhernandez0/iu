/**
 * The GitHub Pages demo build.
 *
 * `tools/pages/build.mjs` was uncovered until now, and two bugs shipped because
 * of that: the demo's sidecar subtitles reappeared in the track list after you
 * opened your own file, and the demo opened itself on a timer that fought you for
 * the file picker. Neither is visible in the extension, so nothing else could
 * catch them.
 *
 * These run `build.mjs` for real, into a temp directory, and assert on the HTML it
 * produces. The build is a pure function of `src/`, the media directory and the
 * checkouts, so this is hermetic: no browser, no network. ffmpeg is not needed
 * either, the media is only copied.
 *
 * Run: node test/pages.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const OUT = join(ROOT, 'build', 'pages-test');

let failures = 0;
let checks = 0;

/** @param {string} name @param {any} actual @param {any} expected */
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  pass  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`);
    failures++;
  }
}

/** @param {string} name */
function section(name) {
  console.log(`\n${name}`);
}

// Built once. `--out` writes somewhere other than `build/pages` so a test run
// cannot clobber the directory a developer has open.
section('the demo builds');

{
  execFileSync(process.execPath, ['tools/pages/build.mjs', '--out', OUT], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  check('index.html was written', existsSync(join(OUT, 'index.html')), true);
  check('the viewer was copied', existsSync(join(OUT, 'src/viewer/viewer.js')), true);
}

const html = readFileSync(join(OUT, 'index.html'), 'utf8');

section('the demo media is offered by a button, and never on a timer');

{
  // A BUTTON, not an auto-open. The timer replaced whatever you had opened a few
  // seconds after you opened it, so trying your own file on the demo meant racing
  // the page. Asserted as the ABSENCE of a load call outside the click handler,
  // which is the property that matters rather than the markup.
  check('an offer element exists', html.includes('id="demo-offer"'), true);
  check('with a button', html.includes('id="demo-load"'), true);
  check('the button starts hidden', /id="demo-offer" hidden/.test(html), true);

  // The offer is wired to `click`, and the fetch happens inside that handler.
  check('the load is inside a click listener', /addEventListener\('click', async \(\) => /.test(html), true);

  // No bare top-level fetch of the media, which is what the auto-open was.
  const beforeClick = html.slice(0, html.indexOf("addEventListener('click'"));
  check('nothing fetches the media before the click handler', /fetch\(/.test(beforeClick), false);
}

section('the offer names the film, briefly');

{
  // Public domain needs no attribution, but a demo that plays a film should say
  // which film. Director and year only: an earlier version carried the licence, the
  // source and a note about the encoding, which read as a lecture under a file
  // picker. The detail lives in THIRD-PARTY.md for anyone who wants it.
  check('the film is named', html.includes('Princess Iron Fan'), true);
  check('the year is given', html.includes('(1941)'), true);
  check('the directors are named', /dir\. Wan Laiming and Wan Guchan/.test(html), true);

  // The lecture is gone, and asserted gone so it cannot creep back.
  check('no licence paragraph inline', /public domain/i.test(html.replace(/THIRD-PARTY|PRIVACY/gi, '')), false);
  check('no archive.org link in the page chrome', html.includes('archive.org/details'), false);
  check('no about-? control', html.includes('id="demo-about"'), false);
}

section('the offer is gated to GitHub Pages');

{
  // The gate is a hostname test at runtime, not a build-time flag, so one artifact
  // is correct in both places. A local `npm run pages:build` must show an empty
  // viewer: there is no media directory in a fresh checkout, and an offer that
  // fetches a 404 is worse than no offer.
  check('the gate tests the Page host', html.includes("endsWith('.github.io')"), true);
  check('the gate guards showing the offer', /if \(onPages && \(video \|\| subtitles\.length\)\)/.test(html), true);
  // Hidden by default in the markup as well, so the gate failing leaves it off
  // rather than flashing an offer that cannot work.
  check('and the offer is hidden in the markup as the fallback', /id="demo-offer" hidden/.test(html), true);
}

section('--force-offer reproduces the deployed page for local review');

{
  // The gate above makes the offer invisible in local development, which meant
  // there was no way to LOOK at it before shipping. `--force-offer` blanks the
  // check for one build so the dev server can show it at a URL.
  const preview = join(ROOT, 'build', 'pages-preview-test');
  execFileSync(process.execPath, ['tools/pages/build.mjs', '--force-offer', '--out', preview], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const previewHtml = readFileSync(join(preview, 'index.html'), 'utf8');

  check('the host check is replaced', /const onPages = true/.test(previewHtml), true);
  check('the marker says why', /force-offer/.test(previewHtml), true);
  // The gate still exists in the normal build, which is the point of a flag rather
  // than deleting the check.
  check('and the plain build keeps the host check', /endsWith\('\.github\.io'\)/.test(html), true);
  check('while the preview build does not', /endsWith\('\.github\.io'\)/.test(previewHtml), false);

  rmSync(preview, { recursive: true, force: true });
}

section('the offer sits in the empty state, not over the picture');

{
  // `.placeholder` is `pointer-events: none` so it never eats clicks meant for the
  // video, and that is inherited. Without `auto` on the offer the button is
  // unclickable, which makes it a build-level requirement rather than styling.
  check('the offer re-enables pointer events', /#demo-offer \{[^}]*pointer-events: auto/.test(html), true);
  // Inside the placeholder, so it disappears once a file is open. `.bar` is out of
  // the question: it auto-hides on pointer idle.
  const placeholderStart = html.indexOf('id="placeholder"');
  const placeholderEnd = html.indexOf('The captions, floating over the bottom');
  const offerIndex = html.indexOf('id="demo-offer"');
  check(
    'the offer is inside the placeholder element',
    placeholderStart !== -1 && offerIndex > placeholderStart && offerIndex < placeholderEnd,
    true,
  );
}

section('the demo paths are relative, so they survive the Pages subpath');

{
  // A project site is served from /<repo>/, not the domain root, so a
  // root-absolute specifier resolves one level ABOVE the site and 404s. This bit
  // twice: the two shim imports, and `runtime.getURL`. Both are asserted.
  const entry = readFileSync(join(OUT, 'demo-entry.js'), 'utf8');
  const shim = readFileSync(join(OUT, 'chrome-shim.js'), 'utf8');

  check('demo-entry imports the viewer relatively', /import '\.\/src\/viewer\/viewer\.js'/.test(entry), true);
  check('chrome-shim imports settings relatively', /from '\.\/src\/common\/settings\.js'/.test(shim), true);
  // A bare specifier is rejected by the browser as a package name, and the symptom
  // is a blank page with no request for the file at all.
  check('and no bare src/ specifier anywhere', /from '(?!\.)(?!\/)[^']*src\//.test(entry + shim), false);
  check('and no root-absolute /src/ specifier', /['"]\/src\//.test(entry + shim), false);

  // `runtime.getURL` must resolve against the page, not the domain root.
  check('getURL resolves against document.baseURI', shim.includes('new URL(path, document.baseURI).href'), true);
}

section('the demo does not rewrite the shipped viewer beyond paths and the script');

{
  // The value of this page is that it runs the SHIPPED viewer. If the build starts
  // patching behaviour, what the demo proves stops being about what people install.
  const viewer = readFileSync(join(OUT, 'src/viewer/viewer.js'), 'utf8');
  const source = readFileSync(join(ROOT, 'src/viewer/viewer.js'), 'utf8');
  check('viewer.js is copied byte for byte', viewer === source, true);

  const viewerHtml = readFileSync(join(OUT, 'src/viewer/viewer.html'), 'utf8');
  const viewerHtmlSource = readFileSync(join(ROOT, 'src/viewer/viewer.html'), 'utf8');
  check('viewer.html is copied byte for byte', viewerHtml === viewerHtmlSource, true);
}

rmSync(OUT, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
