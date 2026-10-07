/**
 * Checks on the extension manifest and the assets it points at.
 *
 * This exists because of a real defect: `manifest.json` declared no icon at all,
 * so Chrome drew a letter tile from the extension name and rendered only the
 * first character — `IU` became a toolbar tile reading `I`. Nothing failed; a
 * missing icon is invisible in a directory listing and only shows up in Chrome.
 *
 * The checks here are deliberately shallow. They cannot judge whether the artwork
 * is legible at 16px — that is a visual question for a person — but they can
 * catch the failure mode that actually happened: a manifest pointing at a path
 * that does not exist, or at a file that is not the size it claims.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(ROOT, 'manifest.json');

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

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/** Sizes Chrome documents for `icons`, and the ones it uses day to day. */
const REQUIRED_ICON_SIZES = ['16', '32', '48', '128'];

/**
 * Read a PNG's real dimensions from its header.
 *
 * Parsed rather than assumed, because the point is to catch a file that is not
 * what its name says. A 128px icon saved as icon-16.png would render blank or
 * squashed, and `existsSync` would be perfectly happy with it.
 *
 * @param {string} file
 * @returns {{ok: boolean, width: number, height: number}}
 */
function pngSize(file) {
  const bytes = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    return { ok: false, width: 0, height: 0 };
  }
  // The IHDR chunk is first, so width and height sit at fixed offsets.
  return { ok: true, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

section('the manifest declares an icon, so no letter tile is used');

// The exact bug: with no `default_icon`, Chrome falls back to a generated tile
// and draws only the first letter of the name.
check('the action has a default_icon', Boolean(manifest.action?.default_icon), true);
check('and a top-level icons block', Boolean(manifest.icons), true);
check('the toolbar icon is 16px', Boolean(manifest.action?.default_icon?.['16']), true);

section('every declared icon exists and is the size it claims');

for (const size of REQUIRED_ICON_SIZES) {
  const declared = manifest.icons?.[size];
  check(`icons["${size}"] is declared`, typeof declared, 'string');

  if (typeof declared === 'string') {
    const file = join(ROOT, declared);
    // `existsSync` before reading, so a missing file reports as missing rather
    // than as a stack trace from `readFileSync`.
    check(`icons["${size}"] exists on disk`, existsSync(file), true);
    if (existsSync(file)) {
      const { ok, width, height } = pngSize(file);
      check(`icons["${size}"] is a real PNG`, ok, true);
      // Square and exactly the declared size. An icon that is the wrong size is
      // silently stretched by Chrome, which is the kind of thing nobody notices
      // until it looks wrong on one particular surface.
      check(`icons["${size}"] is ${size}x${size}`, `${width}x${height}`, `${size}x${size}`);
    }
  }
}

section('the action icon is one of the declared icons, not a separate asset');

for (const [size, path] of Object.entries(manifest.action?.default_icon ?? {})) {
  const declared = manifest.icons?.[size];
  // A second set of files for the toolbar would be a second thing to keep in
  // sync. Pointing at the same PNGs means one source of truth.
  check(`action.default_icon["${size}"] matches icons["${size}"]`, path, declared);
}

section('the icon source is committed, so the PNGs can be regenerated');

// The PNGs are committed because there is no build step, but a set of binaries
// with no source is unmaintainable — nobody can recolour it. The SVG is what
// makes them reproducible.
check('icons/icon.svg exists', existsSync(join(ROOT, 'icons', 'icon.svg')), true);
check('the generator exists', existsSync(join(ROOT, 'tools', 'make-icons.mjs')), true);

section('package.json and the manifest describe the extension the same way');

{
  // The store reads the manifest's description; everyone else reads package.json.
  // They said different things for a while — the manifest had been rewritten for
  // publication while package.json still called the project "Personal-use Chrome
  // extension", which is the framing that was deliberately removed everywhere
  // else. Two descriptions of one product drift because nothing compares them.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  check('the descriptions match', pkg.description, manifest.description);
  // The store rejects a description over 132 characters, and it reads the
  // MANIFEST — so this is the one place the limit has to be enforced.
  check('and fit the store limit', manifest.description.length <= 132, true);
  // A description that disagrees with the version is a description of a different
  // product. Both are bumped together at release time or not at all.
  check('and the versions match', pkg.version, manifest.version);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
