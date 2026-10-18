/**
 * Write one browser's view of the manifest.
 *
 *   node tools/make-manifest.mjs <chrome|firefox> <out.json>
 *
 * ## Why this exists
 *
 * One manifest serves both browsers today, and each ignores the other's keys. That
 * works, and `web-ext lint` reports the cost as three warnings on every Firefox build:
 *
 *   - `sidePanel` is not a Firefox permission at all, so it is reported as invalid;
 *   - `background.service_worker` is Chrome-only and ignored by Firefox;
 *   - `side_panel` is Chrome-only and ignored by Firefox.
 *
 * Warnings that are permanent and explained are tolerable, but a permission set that
 * names an API the browser does not have is not really "the permissions this build
 * needs". The point of this tool is that each store receives a manifest that says
 * ONLY what its browser supports, so the permission list in each package is exactly
 * the list that applies to it.
 *
 * ## Why generated rather than two files
 *
 * Two checked-in manifests would be two things to keep in step, and this repository
 * has been bitten by exactly that twice (`japanese.json`, `defaultThreshold`). One
 * source manifest plus a transform means the browsers cannot disagree about the name,
 * the version, the description, the icons or the content scripts: those are copied
 * verbatim, and only the known-divergent keys are rewritten.
 *
 * ## What is removed, and why each is safe
 *
 * Removed keys are ones the OTHER browser ignores anyway, so dropping them changes
 * nothing about behaviour and only changes what a reviewer reads.
 *
 * @see Makefile, `make stage TARGET=...`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const [target, outFile] = process.argv.slice(2);
if (!['chrome', 'firefox'].includes(target) || !outFile) {
  console.error('usage: node tools/make-manifest.mjs <chrome|firefox> <out.json>');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const out = structuredClone(manifest);

/**
 * Permissions that belong to one browser only.
 *
 * `sidePanel` is the whole reason this transform is worth having: it is the Chrome
 * permission for the side panel, and Firefox does not implement the API at all, so
 * asking for the permission there is asking for nothing. Firefox's panel is
 * `sidebar_action`, which needs no permission.
 */
const CHROME_ONLY_PERMISSIONS = ['sidePanel'];

if (target === 'firefox') {
  // Firefox reads `browser_specific_settings` and `sidebar_action`; Chrome rejects
  // `browser_specific_settings` as an unrecognised key, so it is removed below.
  delete out.side_panel;
  delete out.minimum_chrome_version;
  if (out.background) delete out.background.service_worker;
  out.permissions = (out.permissions ?? []).filter((name) => !CHROME_ONLY_PERMISSIONS.includes(name));
} else {
  delete out.browser_specific_settings;
  delete out.sidebar_action;
  if (out.background) delete out.background.scripts;
}

// Both stores require the manifest at the archive root, and an empty permissions
// array is valid but misleading. Dropped rather than left as `[]` so the package does
// not claim to request nothing when it requests three things.
if (Array.isArray(out.permissions) && out.permissions.length === 0) delete out.permissions;

writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(`  ${target}: ${outFile}`);
