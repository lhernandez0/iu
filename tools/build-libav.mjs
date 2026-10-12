/**
 * Rebuild `src/vendor/libav*.{js,mjs,wasm}` from source.
 *
 *   node tools/build-libav.mjs [--checkout <dir>]
 *
 * ## Why this exists
 *
 * `src/vendor/libav.js` is a custom build of [libav.js](https://github.com/
 * Yahweasel/libav.js) (LGPL-2.1) carrying an `iu` variant, committed for the same
 * reason `mediabunny.js` is: the release ZIP is assembled from `src/` alone and
 * cannot depend on `node_modules` or a build machine.
 *
 * Nobody needs this script to run, test, or ship. It exists so the three
 * committed files can be reproduced rather than trusted.
 *
 * ## What it depends on
 *
 * Docker (emscripten/emsdk), git, curl, tar, xz, and network access to
 * `github.com`. It is the only thing in this project that needs Docker.
 *
 * ## Why it does not just run libav.js's own build
 *
 * Three differences, each load-bearing:
 *
 * 1. libav.js downloads FFmpeg from `ffmpeg.org`, which is not reachable here. We
 *    fetch the same source from `codeload.github.com` and repack it as the
 *    `ffmpeg-<version>.tar.xz` libav.js expects.
 * 2. libav.js builds via `docker/Dockerfile`, which wants a Dockerfile pipeline.
 *    We invoke `emscripten/emsdk` directly with the host uid, so files come out
 *    owned by the user rather than root.
 * 3. libav.js's `build` target builds EVERY variant. We build one, which is the
 *    difference between 4 minutes and an hour.
 *
 * ## Licence note
 *
 * Our change is a CONFIGURATION change: a new entry in `configs/mkconfigs.js`.
 * libav.js's own `LICENSE.md` exempts configuration changes from the
 * share-your-modifications obligation ("changes that link to FFmpeg"), and the
 * build is LGPL-2.1 with no `--enable-gpl` or `--enable-nonfree`. The licence
 * headers libav.js embeds in the built files are kept verbatim. See
 * `THIRD-PARTY.md`.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'src', 'vendor');

/**
 * Pinned upstream revisions.
 *
 * Both are commits, not branches: a moving target would make the committed
 * artifact unreproducible, which is the whole point of having this script.
 */
const LIBAV = {
  repo: 'https://github.com/Yahweasel/libav.js.git',
  commit: 'c05a676d16c1068cce6115594858c50a7ecad4b8',
  version: '6.10.9.0',
};
const FFMPEG = {
  // `git ls-remote --tags https://github.com/FFmpeg/FFmpeg.git n9.0`
  commit: '5b9252abfe2fda0ccb71ed45cd7a954cc45d2b6f',
  version: '9.0',
  // Recorded so the tarball can be verified rather than assumed. This is the
  // hash of the tree WE built from, produced from the GitHub tag, not of the
  // ffmpeg.org release: the two are the same source but not the same bytes.
  sha256: '840707528f804b0d92a2e132fd625be0e5a80424c33877d68e3e178fc673a8a4',
};

const EMSCRIPTEN_IMAGE = 'emscripten/emsdk';
const VARIANT = 'iu';

/** @param {string} file @param {number} minBytes */
function assertPresent(file, minBytes) {
  if (!existsSync(file)) throw new Error(`missing: ${file}`);
  const { size } = statSync(file);
  if (size < minBytes) throw new Error(`too small: ${file} is ${size} bytes`);
  return size;
}

/** @param {string} cmd @param {string[]} args @param {object} [opts] */
function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

const flagIndex = process.argv.indexOf('--checkout');
const checkout =
  flagIndex !== -1
    ? process.argv[flagIndex + 1]
    : join(ROOT, 'build', 'libav-src');

console.log(`\nlibav.js checkout: ${checkout}`);

if (!existsSync(join(checkout, 'Makefile'))) {
  if (existsSync(checkout)) {
    throw new Error(
      `${checkout} exists but does not look like a libav.js checkout; ` +
        `remove it or pass --checkout <dir>`,
    );
  }
  mkdirSync(dirname(checkout), { recursive: true });
  run('git', ['clone', LIBAV.repo, checkout]);
}

// Fetch the pinned commit only if it is not already present. Cloning master
// usually has it, and `git fetch --depth 1 origin <sha>` depends on the server
// allowing reachable-SHA fetches, so this is the fallback rather than the first
// move.
try {
  run('git', ['cat-file', '-e', `${LIBAV.commit}^{commit}`], { cwd: checkout, stdio: 'pipe' });
} catch {
  run('git', ['fetch', '--depth', '1', 'origin', LIBAV.commit], { cwd: checkout });
}
run('git', ['checkout', '--force', LIBAV.commit], { cwd: checkout });
console.log(`  at ${LIBAV.commit}`);

// Our variant, into the checkout. This is the one edit to libav.js's own tree.
run('node', [join(ROOT, 'tools', 'libav', 'add-variant.mjs'), checkout]);

// libav.js regenerates `configs/configs/<variant>/` from `configs/mkconfigs.js`.
run('node', ['mkconfigs.js'], { cwd: join(checkout, 'configs') });

// ---------------------------------------------------------------------------
// FFmpeg source
// ---------------------------------------------------------------------------

const tarball = join(checkout, 'build', `ffmpeg-${FFMPEG.version}.tar.xz`);

if (!existsSync(tarball)) {
  console.log(`\nFFmpeg ${FFMPEG.version} from codeload (ffmpeg.org is unreachable here)`);
  const work = join(checkout, 'build', '.ffmpeg-fetch');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  // GitHub's tarball endpoint serves the source for a commit ref, which for an
  // annotated tag is the tag object, and a tag object is not a tree. Resolving
  // the tag to its commit first means the URL always names a commit.
  const url = `https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/${FFMPEG.commit}`;
  run('curl', ['-fsSL', url, '-o', join(work, 'ffmpeg.tar.gz')]);
  run('tar', ['xzf', join(work, 'ffmpeg.tar.gz'), '-C', work]);

  // codeload's top directory is named `<repo>-<commit>`; libav.js's Makefile
  // hard-codes `ffmpeg-<version>` and untars straight into `build/`.
  const extracted = join(work, `FFmpeg-${FFMPEG.commit}`);
  if (!existsSync(extracted)) {
    throw new Error(`expected ${extracted} after extraction; codeload layout changed`);
  }
  run('mv', [extracted, join(work, `ffmpeg-${FFMPEG.version}`)]);
  run('tar', ['cJf', tarball, '-C', work, `ffmpeg-${FFMPEG.version}`]);
  rmSync(work, { recursive: true, force: true });

  const hash = execFileSync('sha256sum', [tarball], { encoding: 'utf8' }).split(/\s+/)[0];
  if (hash !== FFMPEG.sha256) {
    console.log(`  note: sha256 ${hash}`);
    console.log(`        recorded ${FFMPEG.sha256}`);
    console.log('        (same source, different packing; update the constant if intentional)');
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const target = `dist/libav-${LIBAV.version}-${VARIANT}.wasm.mjs`;
// Two targets, not one: the wasm pair and the JS loader are built by different
// rules. The loader (`dist/libav-<variant>.mjs`) is a minified copy of the
// versioned one and needs no FFmpeg, so it is quick even after a full rebuild.
const targets = `${target} dist/libav-${VARIANT}.mjs`;
const havePkgConfig = (() => {
  try {
    execFileSync('docker', [
      'run', '--rm', '-u', `${process.getuid()}:${process.getgid()}`,
      EMSCRIPTEN_IMAGE, 'bash', '-lc', 'command -v pkg-config',
    ], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

console.log(`\nbuilding ${targets} in ${EMSCRIPTEN_IMAGE}`);
console.log('  this takes a few minutes; the wasm links at the end');

// `make` installs the checkout's npm dependencies (terser) on first use, so the
// container needs a writable HOME and node_modules. Running as the host uid
// keeps every output file owned by the user instead of root.
const script = [
  'set -e',
  'export HOME=/tmp',
  'cd /src',
  `make ${targets}`,
].join(' && ');

const dockerArgs = [
  'run', '--rm',
  '-u', `${process.getuid()}:${process.getgid()}`,
  '-v', `${checkout}:/src`,
  '-e', 'EM_CACHE=/src/.em-cache',
  EMSCRIPTEN_IMAGE, 'bash', '-lc', script,
];
if (!havePkgConfig) {
  // We disable every external library and enable only what FFmpeg contains, so
  // pkg-config has nothing to find. emconfigure prints a warning and continues.
  console.log('  (pkg-config is absent in the image; harmless for this config)');
}
run('docker', dockerArgs);

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------

const dist = join(checkout, 'dist');
const outputs = {
  // Renamed from `libav-<version>-iu.mjs` upstream: the loader finds the wasm
  // files by a name IT constructs and fetches relative to its own URL, never by
  // its own filename, so it works under any name. `libav.js` is clearer at the
  // import site than a versioned one.
  [`libav.js`]: join(dist, `libav-${VARIANT}.mjs`),
  [`libav-${LIBAV.version}-${VARIANT}.wasm.mjs`]: join(dist, `libav-${LIBAV.version}-${VARIANT}.wasm.mjs`),
  [`libav-${LIBAV.version}-${VARIANT}.wasm.wasm`]: join(dist, `libav-${LIBAV.version}-${VARIANT}.wasm.wasm`),
};

console.log('\nvendoring');
for (const [name, from] of Object.entries(outputs)) {
  const bytes = assertPresent(from, 10_000);
  copyFileSync(from, join(VENDOR, name));
  console.log(`  ${name.padEnd(36)} ${(bytes / 1024).toFixed(0).padStart(5)} KB`);
}

// The paths live in the build config, so a formula block is generated from them
// rather than typed twice. `--check` will diff this against the committed file.
const formula = {};
for (const [name, from] of Object.entries(outputs)) {
  formula[name] = execFileSync('sha256sum', [from], { encoding: 'utf8' }).split(/\s+/)[0];
}
writeFileSync(
  join(ROOT, 'tools', 'libav', 'hashes.json'),
  JSON.stringify(formula, null, 2) + '\n',
);

// The README is generated the way `build-vendor.mjs` generates its own, so the
// note cannot describe a state the files are no longer in.
writeFileSync(
  join(VENDOR, 'README.md'),
  [
    '# `src/vendor/`',
    '',
    'Generated. Do not edit by hand.',
    '',
    '- `mediabunny.js`, run `node tools/build-vendor.mjs`.',
    '- `libav.js` and the two `libav-*` files, run `node tools/build-libav.mjs`.',
    '',
    'Both are committed because the release ZIP is built from `src/` alone and',
    'cannot depend on `node_modules` or a build machine. See `THIRD-PARTY.md`.',
    '',
  ].join('\n'),
);

console.log('\ndone');
