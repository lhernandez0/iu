/**
 * Rebuild the generated bundle and assert it is byte-identical to the committed one.
 *
 *   node tools/verify-source.mjs
 *
 * ## Why this exists
 *
 * `src/vendor/mediabunny.js` is minified, so Mozilla's review requires a source-code
 * submission: the original inputs plus instructions that let a reviewer rebuild the
 * file and diff it against the one in the package. Their rule is that the rebuild
 * must produce **no differences**, because a rebuild that does not match is exactly
 * how a backdoor is hidden.
 *
 * That makes "does it reproduce?" a fact this project has to keep true, not a fact
 * somebody checked once. `npm run wordlists:check` and the readings check already
 * work this way for the dictionaries and the reading tables: regenerate, compare
 * bytes, fail on any difference. This is the same shape for the one generated code
 * file, so the property cannot silently rot between releases.
 *
 * ## What it does NOT do
 *
 * It does not run `npm ci`. The reviewer does, because they start from a bare
 * machine, but this runs inside a checkout that already has `node_modules`, and
 * installing from the registry on every `make release` would make the packaging
 * step need the network. The lockfile the reviewer installs from is checked in
 * `test/manifest.test.mjs` (it must be present and shipped-adjacent); what is
 * checked HERE is that the committed dependency tree produces the committed file.
 *
 * It rebuilds in a TEMP COPY rather than in place. Running the build in the working
 * tree would overwrite the very file being verified, so a failure could not be told
 * apart from a success that happened to write the same bytes, and a crash mid-build
 * would leave the tree dirty. The temp copy is `src/`, `tools/`, `package.json` and
 * `package-lock.json`, with `node_modules/` symlinked so the copy cannot modify it.
 *
 * @see Makefile, `make verify-source`
 */

import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = join('src', 'vendor', 'mediabunny.js');
const COMMITTED = join(ROOT, GENERATED);

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

/** @param {string} file @returns {string} */
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

if (!existsSync(COMMITTED)) {
  console.error(`  FAIL  ${GENERATED} is missing.\n        Run: node tools/build-vendor.mjs`);
  process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), 'iu-verify-source-'));
try {
  // The inputs the build reads: the source tree, the build script, and the two
  // package files that pin the dependency versions. `cpSync` with `recursive` and a
  // filter is not used for `src/` because the whole tree is small and needed (the
  // entry point names modules from several of its directories).
  for (const entry of ['src', 'tools', 'package.json', 'package-lock.json']) {
    cpSync(join(ROOT, entry), join(temp, entry), { recursive: true });
  }
  // Symlinked, not copied: 52 MB, and the copy must not be able to modify it. A
  // symlink is enough because esbuild only reads from here.
  symlinkSync(join(ROOT, 'node_modules'), join(temp, 'node_modules'), 'dir');

  const rebuilt = join(temp, GENERATED);
  execFileSync(process.execPath, [join(temp, 'tools', 'build-vendor.mjs')], {
    cwd: temp,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const committedHash = sha256(COMMITTED);
  const rebuiltHash = sha256(rebuilt);

  console.log(`\nrebuild reproducibility\n`);
  console.log(`  committed  ${committedHash}`);
  console.log(`  rebuilt    ${rebuiltHash}`);

  check('the rebuild produced a file', existsSync(rebuilt), true);
  check('and it is byte-identical to the committed one', rebuiltHash, committedHash);

  // Only compared once the hashes match, because this is the line the reviewer reads
  // and a byte offset into a 4 MB file is useless without knowing where it diverges.
  if (rebuiltHash === committedHash) {
    check(
      'and the size matches',
      readFileSync(rebuilt).length,
      readFileSync(COMMITTED).length,
    );
  } else {
    const a = readFileSync(COMMITTED);
    const b = readFileSync(rebuilt);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.error(`          first difference at byte ${i}`);
    console.error(`          committed: ${JSON.stringify(a.subarray(Math.max(0, i - 20), i + 40).toString('latin1'))}`);
    console.error(`          rebuilt:   ${JSON.stringify(b.subarray(Math.max(0, i - 20), i + 40).toString('latin1'))}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
