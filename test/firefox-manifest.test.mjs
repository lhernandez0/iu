/**
 * The cross-browser seam.
 *
 * The extension declares support for Chrome and Firefox from ONE source manifest, and
 * `tools/make-manifest.mjs` splits it per browser. This suite asserts the parts that
 * actually differ between the two, because those are the parts a browser will reject
 * or silently ignore, and because nothing else runs Firefox (see the note below).
 *
 * ## Why this exists rather than a Firefox run
 *
 * The browser tier is Chromium-only. A Firefox run was attempted and the environment
 * could not drive it: Firefox segfaults when Playwright launches it with an empty
 * profile here, `about:` pages are not navigable through Playwright, and sideloading
 * an unsigned XPI needs a profile flag that is not settable without one of the two.
 * `web-ext run` DOES install the extension into Firefox ("Installed ... as a temporary
 * add-on"), so the extension is loadable; it is the automated driving that is not
 * available here.
 *
 * So this file asserts what can be checked WITHOUT a browser, which is the manifest
 * shape and the API detection, and `test/browser/firefox.test.mjs` attempts the real
 * run and skips with a message when it cannot. A structural test that runs everywhere
 * is worth more than a browser test that never runs, and it is honest about which is
 * which.
 *
 * Run with: `npm test`
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

/** Run `tools/make-manifest.mjs` for a target and return the parsed result. */
function derived(target) {
  const out = join(ROOT, 'build', `manifest.${target}.test.json`);
  execFileSync(process.execPath, ['tools/make-manifest.mjs', target, out], { cwd: ROOT });
  return JSON.parse(readFileSync(out, 'utf8'));
}

section('each browser receives only the keys it understands');

{
  const source = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const chrome = derived('chrome');
  const firefox = derived('firefox');

  // Chrome rejects `browser_specific_settings` as an unknown key and has no
  // `sidebar_action`; Firefox has no `side_panel` and ignores `service_worker`.
  // Each of these is a warning from `web-ext lint` against the shared manifest, and
  // the split is what removes it.
  check('Chrome carries no Firefox-only keys', Object.keys(chrome).filter((k) => ['browser_specific_settings', 'sidebar_action'].includes(k)), []);
  check('Chrome has no Firefox background form', Boolean(chrome.background?.scripts), false);
  check('Firefox carries no Chrome-only keys', Object.keys(firefox).filter((k) => ['side_panel', 'minimum_chrome_version'].includes(k)), []);
  check('Firefox has no Chrome background form', Boolean(firefox.background?.service_worker), false);

  // The permission that made the split worth doing. Firefox has no `sidePanel` API,
  // so requesting it there asks for nothing; its panel is `sidebar_action`, which
  // needs no permission. Asserted on BOTH sides, because dropping it from the wrong
  // one would break the panel in the browser that needs it.
  check('Firefox does not request the Chrome panel permission', firefox.permissions.includes('sidePanel'), false);
  check('Chrome still does', chrome.permissions.includes('sidePanel'), true);

  // Everything a browser does NOT differ on is copied verbatim, so the two packages
  // cannot disagree about the product's identity. This is the property that makes a
  // generated manifest better than two checked-in ones.
  const SHARED = ['name', 'version', 'description', 'manifest_version', 'icons', 'action', 'content_scripts', 'host_permissions', 'content_security_policy'];
  const drifted = SHARED.filter(
    (key) => JSON.stringify(chrome[key]) !== JSON.stringify(source[key]),
  );
  check('the shared keys are identical to the source, on the Chrome side', drifted, []);
  const driftedFx = SHARED.filter(
    (key) => JSON.stringify(firefox[key]) !== JSON.stringify(source[key]),
  );
  check('and on the Firefox side', driftedFx, []);

  // Each keeps the panel and the background entry point its browser actually runs.
  check('Chrome keeps the side panel', Boolean(chrome.side_panel), true);
  check('Firefox keeps the sidebar', Boolean(firefox.sidebar_action), true);
  check('Chrome keeps the service worker', Boolean(chrome.background?.service_worker), true);
  check('Firefox keeps the background script', Boolean(firefox.background?.scripts), true);
}

section('the Firefox floor is one the browser can act on');

{
  const firefox = derived('firefox');
  // `data_collection_permissions` is read by Firefox 140 and later. Below that the
  // key is ignored, so the "no data collected" statement is not shown to a user who
  // installs on 128-139. `manifest.test.mjs` pins this too; repeated here because
  // this file is where the Firefox reasoning lives.
  const floor = Number.parseFloat(String(firefox.browser_specific_settings?.gecko?.strict_min_version ?? '0'));
  check('Firefox 140 or later is required', floor >= 140, true);
  check('and the consent position survives the split', firefox.browser_specific_settings?.gecko?.data_collection_permissions, { required: ['none'] });
  // No Android floor is declared, and that is deliberate: there is no sidebar on
  // Firefox for Android, so the extension does not target it. Declaring 142 would
  // silence the linter's remaining warning by claiming a platform we do not ship.
  check('no Android floor is declared for a platform with no sidebar', Boolean(firefox.browser_specific_settings?.gecko_android), false);
}

section('the code reads each browser API through a feature test, not a global');

{
  // `globalThis.browser ?? globalThis.chrome` at each use site is the project
  // convention (AGENTS.md), and the panel open is the one genuinely incompatible
  // call. This asserts the detection is still there rather than assuming it: the
  // whole point of the split is that the seam is real, and a seam nobody checks is
  // a seam that closes on the next refactor.
  const worker = readFileSync(join(ROOT, 'src', 'background', 'service-worker.js'), 'utf8');
  check('the worker detects the Chrome panel API', /api\.sidePanel\?\.open/.test(worker), true);
  check('and falls back to the Firefox sidebar API', /api\.sidebarAction\?\.toggle/.test(worker), true);

  // The content script world, which differs between the browsers and is declared in
  // the manifest rather than detected at runtime.
  const source = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const mainWorld = (source.content_scripts ?? []).filter((s) => s.world === 'MAIN');
  check('one content script runs in the page world', mainWorld.length, 1);
  check('and it is the page bridge', mainWorld[0]?.js, ['src/content/page-bridge.js']);
}

section('the source package gives a reviewer what the rebuild needs');

{
  // The AMO requirement is that a reviewer can rebuild the minified file from the
  // source package, so the package has to CONTAIN the build script, the inputs, the
  // lockfile and the reviewer README. `tools/verify-source.mjs` proves the rebuild
  // itself is reproducible; this proves the PACKAGE is complete, which is a
  // different failure: a package missing its lockfile rebuilds to different bytes
  // for a reviewer and to the same bytes for us.
  //
  // Read from the Makefile rather than restated, so the package list lives in one
  // place. `SOURC...` is not a variable in this project, the list is in the recipe;
  // so the OWNING facts are checked instead: each file the recipe names exists in
  // the repository.
  const makefile = readFileSync(join(ROOT, 'Makefile'), 'utf8');
  const recipe = /^source:.*?\n((?:\t.*\n)+)/m.exec(makefile)?.[1] ?? '';
  check('the Makefile has a source recipe', recipe.length > 0, true);

  const required = [
    'src', 'tools/build-vendor.mjs', 'tools/amo/AMO-SOURCE.md',
    'package.json', 'package-lock.json', '.nvmrc',
    'LICENSE', 'THIRD-PARTY.md', 'THIRD-PARTY-NOTES.md', 'manifest.json',
  ];
  const missing = required.filter((path) => !existsSync(join(ROOT, path)));
  check('every file the source recipe copies exists', missing, []);

  // The README the reviewer reads. Mozilla's checklist asks for the OS, the tool
  // versions, the exact commands and the library links, so each is asserted present
  // rather than trusted to stay.
  const reviewerReadme = readFileSync(join(ROOT, 'tools', 'amo', 'AMO-SOURCE.md'), 'utf8');
  check('the reviewer README names the build command', /npm ci/.test(reviewerReadme) && /node tools\/build-vendor\.mjs/.test(reviewerReadme), true);
  check('and the Node version the project pins', /Node\.js \| \*\*24\*\*/.test(reviewerReadme), true);
  check('and the committed hash to diff against', /4822d98bd58e08d2a82dfb01f6ce5a8b7310037eaf47b7d86436436f17c7d4ec/.test(reviewerReadme), true);
  // Every bundled package must be linked at a TAG, which is Mozilla's rule; a link
  // to a branch is the rejected form.
  for (const pkg of ['mediabunny', 'ac3', 'dts', 'aac-encoder']) {
    check(`the README links ${pkg} at a release tag`, new RegExp(`Vanilagy/mediabunny/tree/v1\\.61\\.[34]`).test(reviewerReadme), true);
  }
  check('and never at a branch', /\/tree\/(main|master)\b/.test(reviewerReadme), false);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
