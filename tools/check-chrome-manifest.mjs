/**
 * Validate a staged CHROME manifest.
 *
 *   node tools/check-chrome-manifest.mjs <manifest.json>
 *
 * ## Why not `web-ext lint`
 *
 * `web-ext lint` is Mozilla's validator. Pointed at a Chrome-shaped package it raises
 * two warnings that are correct for Firefox and wrong for Chrome:
 *
 *   - "data_collection_permissions is missing", which is a Firefox-only key;
 *   - "Invalid permissions sidePanel", which is a Chrome-only permission.
 *
 * A green build there would mean suppressing those, and suppressing them would also
 * suppress the day they became true. So the Chrome package is checked by the things
 * that actually matter to Chrome, which are structural and can be asserted exactly.
 *
 * ## What Chrome rejects, and therefore what this checks
 *
 * Chrome fails to load an extension whose manifest names a key it does not know, whose
 * version is not dotted-integer, whose icons are absent from disk, or whose
 * `background.service_worker` points at a file that is not there. Each of those is a
 * real load failure, unlike the Firefox warnings above, so each is checked.
 *
 * @see Makefile, `make lint TARGET=chrome`
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  console.error('usage: node tools/check-chrome-manifest.mjs <manifest.json>');
  process.exit(1);
}

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

const dir = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Firefox-only keys. Chrome treats an unknown top-level key as a hard load failure,
// so `browser_specific_settings` surviving the split would break the package outright.
check(
  'no Firefox-only keys',
  Object.keys(manifest).filter((key) => ['browser_specific_settings', 'sidebar_action'].includes(key)),
  [],
);
check('no Firefox background form', Boolean(manifest.background?.service_worker), true);
check('and no Firefox background scripts', Boolean(manifest.background?.scripts), false);
check('the Chrome panel is declared', Boolean(manifest.side_panel), true);
check('and the Chrome panel permission is requested', (manifest.permissions ?? []).includes('sidePanel'), true);

// Chrome requires a dotted-integer version.
check('the version is dotted integers', /^\d+(\.\d+){0,3}$/.test(String(manifest.version)), true);

// Every file the manifest names has to exist, or the extension fails to load with a
// message about the file rather than about the manifest.
const named = [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
  manifest.side_panel?.default_path,
].filter(Boolean);
const missing = named.filter((path) => !existsSync(join(dir, path)));
check('every file the manifest names exists', missing, []);

// The keys Chrome REQUIRES. `minimum_chrome_version` is optional but present here on
// purpose, and losing it silently would let the package install on a browser that
// cannot run the decoder.
check('manifest_version is 3', manifest.manifest_version, 3);
check('a description is present', typeof manifest.description, 'string');
check('and a name', typeof manifest.name, 'string');
check('minimum_chrome_version is declared', typeof manifest.minimum_chrome_version, 'string');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
