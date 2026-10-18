/**
 * Assert the AMO source package contains exactly what a reviewer's rebuild needs.
 *
 *   node tools/verify-source-zip.mjs <file.zip>
 *
 * ## Why this is separate from `verify-zip.mjs`
 *
 * The two packages are different artefacts with different jobs. The extension ZIP is
 * what a user installs; the source ZIP is what a REVIEWER rebuilds, and Mozilla's
 * rule is that the rebuild must be reproducible from it. A source package that is
 * missing the lockfile, or the build script, or the generated file itself (which is
 * the thing to diff against) cannot be reviewed, and the failure is silent: the zip
 * is valid, it is just not enough.
 *
 * So this asserts the PRESENCE of the files a build reads, and the ABSENCE of the
 * things that only bloat it, and it reads the Makefile's `SOURCED` list rather than
 * restating it, for the same reason `verify-zip.mjs` reads `SHIPPED`.
 *
 * @see Makefile, `make verify-source-zip`
 */

import { readFileSync } from 'node:fs';

const [zipFile] = process.argv.slice(2);
if (!zipFile) {
  console.error('usage: node tools/verify-source-zip.mjs <file.zip>');
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

/** Read the archive's entry names without a zip library. */
function entries(file) {
  const buffer = readFileSync(file);
  const names = [];
  for (let i = 0; i < buffer.length - 4; i++) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLength = buffer.readUInt16LE(i + 28);
    const extraLength = buffer.readUInt16LE(i + 30);
    const commentLength = buffer.readUInt16LE(i + 32);
    names.push(buffer.subarray(i + 46, i + 46 + nameLength).toString('utf8'));
    i += 45 + nameLength + extraLength + commentLength;
  }
  return names;
}

const names = entries(zipFile);
console.log(`  (${names.length} entries in ${zipFile})`);

// The README is renamed to the package root, so it is the first thing a reviewer
// sees. Asserted by that exact path, because a README at `tools/amo/AMO-SOURCE.md`
// is a README nobody opens.
check('the reviewer README is at the package root', names.includes('README.md'), true);

// Present as paths INSIDE the archive. The packer strips the staging directory, so
// these are relative to the package root.
const REQUIRED = [
  'README.md',
  'package.json',
  'package-lock.json',
  '.nvmrc',
  'LICENSE',
  'THIRD-PARTY.md',
  'THIRD-PARTY-NOTES.md',
  // The script the reviewer runs.
  'tools/build-vendor.mjs',
  // The file to diff a rebuild against. Without this there is nothing to compare to.
  'src/vendor/mediabunny.js',
  // Enough of the source tree that the build's imports resolve.
  'src/viewer/viewer.js',
  'manifest.json',
];
const missing = REQUIRED.filter((name) => !names.includes(name));
check('every file a rebuild needs is present', missing, []);

// The lockfile specifically, because `npm ci` fails without it and Mozilla's guide
// names it explicitly: without it a reviewer may resolve different versions and get
// different bytes.
check('the lockfile is not a stub', names.some((n) => n === 'package-lock.json'), true);

// Things that must NOT be there. `test/` and `docs/` are the repository's, not the
// reviewer's; `node_modules/` is restored by `npm ci`; and the generated entry
// scaffolding is removed by the build script itself.
const FORBIDDEN = ['node_modules/', 'docs/', 'test/', '.git/', '.cache/', 'tools/amo/'];
const leaked = FORBIDDEN.filter((prefix) => names.some((name) => name.startsWith(prefix)));
check('and nothing that is not part of the build is', leaked, []);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
