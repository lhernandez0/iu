/**
 * Assert a built ZIP contains exactly what should ship.
 *
 * The failure this exists to catch: a package that installs and works while
 * carrying files it should not. Nobody notices by installing it, the extension
 * behaves identically, and by then it is on a store. The 8.9 MB conversation log
 * under `docs/`, the 52 MB of `node_modules/`, and the real video id in
 * `test/fixtures/` are all things that would have shipped silently if the
 * exclusion list were wrong.
 *
 * So the expected set is derived from the Makefile's own `SHIPPED` list rather than
 * restated here. Restating it would be a second source of truth, which is the
 * problem this is meant to solve.
 *
 * @see Makefile, `make verify`
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const [zipFile] = process.argv.slice(2);
if (!zipFile) {
  console.error('usage: node tools/verify-zip.mjs <file.zip>');
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
  // Walk the central directory rather than the local headers: the central one is
  // what a reader actually uses, and its offsets are absolute.
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

// The Makefile's list, read rather than repeated.
const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8');
const shippedLine = /^SHIPPED := ([\s\S]*?)(?=\n\n)/m.exec(makefile)?.[1] ?? '';
const shipped = shippedLine
  .replace(/\\\n/g, ' ')
  .split(/\s+/)
  .filter((token) => token && !token.startsWith('#'));

check('the Makefile declares what ships', shipped.length > 5, true);

const names = entries(zipFile);
console.log(`  (${names.length} entries in ${zipFile})`);

// --- Nothing that should not be there ----------------------------------------
//
// Checked first and by PREFIX, because this is the failure that actually happens:
// a whole directory arriving because a new tool wrote into it.
//
// ANY leading dot is rejected, with no exception. An earlier version of this
// check carved out `.env.example`, because the Makefile's SHIPPED list had it,
// and that is the wrong direction: the guard was adjusted to permit the thing it
// should have caught. `.env.example` documents `npm run capture`, which is a
// development tool that is not in the package, so it explained a file that would
// not be there. A dotfile in a shipping extension is a mistake until proven
// otherwise, and proving it is a deliberate edit here.
const FORBIDDEN = ['node_modules', 'docs', 'test', 'tools', '.git', '.agents', '.vscode'];
const leaked = [];
for (const entry of names) {
  const top = entry.split('/')[0];
  if (FORBIDDEN.includes(top)) leaked.push(entry);
  if (top.startsWith('.')) leaked.push(entry);
}
check('no development directory or dotfile is inside the package', leaked, []);

// --- Everything that should be -------------------------------------------------
//
// Top-level entries only: the staged set is a list of top-level names, and
// asserting every nested path would restate the filesystem.
const present = new Set(names.map((name) => name.split('/')[0]));
const missing = shipped.filter((entry) => !present.has(entry));
check('everything the Makefile ships is inside the package', missing, []);

// --- The two things both stores check themselves -------------------------------
check('manifest.json is at the archive root', names.includes('manifest.json'), true);

// A store rejects a package whose manifest version disagrees with the release, and
// the message does not say which of the two it disliked.
const manifestEntry = names.indexOf('manifest.json');
check('and the archive has exactly one of it', manifestEntry >= 0 && names.filter((n) => n === 'manifest.json').length, 1);

const version = JSON.parse(readFileSync('manifest.json', 'utf8')).version;
check('the filename carries the manifest version', zipFile.includes(version), true);

// --- The archive's own structure -----------------------------------------------
//
// Every check above reads the zip's CENTRAL DIRECTORY, which is a list of names
// and sizes. That list can be perfectly well-formed while the archive is not
// readable at all, and it was.
//
// `tools/pack.mjs` was writing central records with no local-header offset (byte
// 42), so every entry claimed to start at position 0. The central directory read
// as a normal 38-file archive, this script passed 7/7, and `unzip` refused the
// file outright with "invalid zip file with overlapped components (possible zip
// bomb)". Both stores would have rejected it. The one thing that would have caught
// it is asking a real ZIP reader to read it.
//
// So the last check shells out. `unzip` is not required to BUILD the package,
// that is why pack.mjs exists, but a workspace that cannot test the artifact it
// produces is not verifying anything, and this is the only test that reads the
// bytes the way a store will.
{
  // The SIGNAL IS THE EXIT CODE, not the text. Grepping the output for "error"
  // looks equivalent and is not: a healthy archive makes `unzip -t` print "No
  // errors detected in compressed data of …", so a text match fails the check for
  // passing. The first version of this did exactly that.
  let broken = null;
  try {
    execFileSync('unzip', ['-t', zipFile], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      // `unzip` is not installed. That is why `pack.mjs` exists, so this is a skip
      // rather than a failure, and it says so, because a silent pass would be
      // worse than no check at all.
      console.log('  skip  a real zip reader can read every entry (no `unzip` on PATH)');
      broken = undefined;
    } else {
      // Non-zero exit: the archive is unreadable. Keep the last lines, which name
      // the reason instead of leaving a bare "it failed".
      broken = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`.trim().split('\n').slice(-3).join(' | ');
    }
  }

  if (broken !== undefined) {
    check('a real zip reader can read every entry', broken, null);
    if (broken) console.log(`          ${broken}`);
  }
}

// --- Size, as a sanity bound ---------------------------------------------------
//
// Not a budget: a bound that catches a whole directory arriving without being
// noticed. The dictionaries are 4 MB of the ~4 MB, so anything at 10 MB means
// something is in there that should not be.
const mb = statSync(zipFile).size / 1e6;
check('the package is under 10 MB', mb < 10, true);
console.log(`  (${mb.toFixed(1)} MB zipped)`);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
