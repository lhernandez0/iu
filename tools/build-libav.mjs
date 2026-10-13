/**
 * Build the media decoder into `build/libav/`, ready for the release ZIP.
 *
 *   npm run vendor:libav
 *
 * ## What this produces and why it is not in git
 *
 * Three files: a JS loader, an Emscripten glue file, and a ~5 MB WebAssembly
 * binary containing FFmpeg. They are a BUILD PRODUCT. They are not committed,
 * and they are not fetched at package time either; the release is assembled from
 * a working tree that has been built. See ADR 0011 for the reasoning, which
 * reverses the earlier choice to commit `mediabunny.js`.
 *
 * ## What it needs
 *
 * `emcc` (and `emcmake`/`emconfigure`) on PATH, plus git, curl, tar and xz, and
 * network access to `github.com`. Install Emscripten with `emsdk`:
 *
 *   git clone https://github.com/emscripten-core/emsdk
 *   cd emsdk && ./emsdk install latest && ./emsdk activate latest
 *   source ./emsdk_env.sh
 *
 * There is no Docker. An earlier version used the `emscripten/emsdk` image pinned
 * by digest; 3.4 GB per run is not a price this project should pay for a build
 * that runs a handful of times a year.
 *
 * ## Why it does not run libav.js's own build as-is
 *
 * 1. libav.js downloads FFmpeg from `ffmpeg.org`. We fetch the same source from
 *    `codeload.github.com` and repack it as the tarball libav.js expects, because
 *    the release host is not always reachable.
 * 2. libav.js's `build` target builds EVERY variant. We build one, which is the
 *    difference between four minutes and an hour.
 * 3. We add the `iu` variant, which is the point: a new entry in
 *    `configs/mkconfigs.js`, written by `tools/libav/add-variant.mjs`.
 *
 * ## Licence
 *
 * The change to libav.js is CONFIGURATION: a new variant definition. libav.js's
 * own `LICENSE.md` exempts configuration changes from the share-your-
 * modifications obligation ("changes that link to FFmpeg"). The build is LGPL-2.1
 * with no `--enable-gpl` and no `--enable-nonfree`, checked below. See
 * `THIRD-PARTY.md`.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Where the decoder is written.
 *
 * `src/vendor/`, because that is where the extension loads from: the cosmetic
 * bundle (`mediabunny.js`) is there, and the release ZIP ships `src/` as-is. The
 * three files are **gitignored by name**, so writing here is safe and there is no
 * copy step between "built" and "loadable". `make stage` needs no special case.
 *
 * See the `.gitignore` entry and `THIRD-PARTY.md`.
 */
const OUT_DIR = join(ROOT, 'src', 'vendor');
/** The libav.js checkout, reused between builds. Gitignored. */
const CHECKOUT = join(ROOT, 'build', 'libav-src');

/**
 * Pinned upstream revisions. Commits, not branches, so a build names what it is
 * made from even though the artifact itself is not asserted byte-identical.
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
};
const VARIANT = 'iu';

/**
 * Whether to exclude the video decoders.
 *
 * `--audio-only` exists because the video decoders are measured at 2.39 MB raw /
 * 0.83 MB gzipped, and a release that does not yet decode video should not carry
 * them. `tools/libav/add-variant.mjs` owns which fragments that removes.
 */
const AUDIO_ONLY = process.argv.includes('--audio-only');

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

/** @param {string} cmd */
function have(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Toolchain
// ---------------------------------------------------------------------------

// Checked before anything is downloaded, so a missing toolchain fails in a
// second rather than after a five minute clone.
if (!have('emcc')) {
  console.error(
    'emcc is not on PATH.\n\n' +
      'The media decoder is built with Emscripten. Install it with emsdk:\n\n' +
      '  git clone https://github.com/emscripten-core/emsdk\n' +
      '  cd emsdk && ./emsdk install latest && ./emsdk activate latest\n' +
      '  source ./emsdk_env.sh\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

console.log(`\nlibav.js checkout: ${CHECKOUT}`);

if (!existsSync(join(CHECKOUT, 'Makefile'))) {
  if (existsSync(CHECKOUT)) {
    throw new Error(`${CHECKOUT} is not a libav.js checkout; remove it and retry`);
  }
  mkdirSync(dirname(CHECKOUT), { recursive: true });
  // A full clone, not `--depth 1`: the build stamps a banner from `git describe`,
  // which needs tags, and a shallow clone has none.
  run('git', ['clone', LIBAV.repo, CHECKOUT]);
}

try {
  run('git', ['cat-file', '-e', `${LIBAV.commit}^{commit}`], { cwd: CHECKOUT, stdio: 'pipe' });
} catch {
  run('git', ['fetch', 'origin', LIBAV.commit], { cwd: CHECKOUT });
}
run('git', ['checkout', '--force', LIBAV.commit], { cwd: CHECKOUT });
console.log(`  at ${LIBAV.commit}`);

// The variant definition, which is the change to libav.js's own tree.
run('node', [
  join(ROOT, 'tools', 'libav', 'add-variant.mjs'),
  CHECKOUT,
  ...(AUDIO_ONLY ? ['--audio-only'] : []),
]);

// libav.js generates `configs/configs/<variant>/` from `configs/mkconfigs.js`.
run('node', ['mkconfigs.js'], { cwd: join(CHECKOUT, 'configs') });

// ---------------------------------------------------------------------------
// Licence guard
// ---------------------------------------------------------------------------

// Read from the GENERATED config, which is what the compiler is actually given,
// rather than from the recipe. A `--enable-gpl` arriving through a fragment would
// change libav.js from LGPL to GPL, and GPL cannot be linked into an MIT project.
// This is the one check that must never be skipped.
{
  const configPath = join(CHECKOUT, 'configs', 'configs', VARIANT, 'ffmpeg-config.txt');
  const config = readFileSync(configPath, 'utf8');
  for (const flag of ['--enable-gpl', '--enable-nonfree', '--enable-version3']) {
    if (config.includes(flag)) {
      throw new Error(`${flag} appears in ${configPath}; this build would not be LGPL`);
    }
  }
}

// ---------------------------------------------------------------------------
// FFmpeg source
// ---------------------------------------------------------------------------

const tarball = join(CHECKOUT, 'build', `ffmpeg-${FFMPEG.version}.tar.xz`);

if (!existsSync(tarball)) {
  console.log(`\nFFmpeg ${FFMPEG.version} from codeload`);
  const work = join(CHECKOUT, 'build', '.ffmpeg-fetch');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  // A commit, not the tag: GitHub serves the tag OBJECT for an annotated tag, and
  // a tag object is not a tree.
  const url = `https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/${FFMPEG.commit}`;
  run('curl', ['-fsSL', url, '-o', join(work, 'ffmpeg.tar.gz')]);
  run('tar', ['xzf', join(work, 'ffmpeg.tar.gz'), '-C', work]);

  // codeload names the top directory `<repo>-<commit>`; libav.js's Makefile
  // hard-codes `ffmpeg-<version>`.
  const extracted = join(work, `FFmpeg-${FFMPEG.commit}`);
  if (!existsSync(extracted)) {
    throw new Error(`expected ${extracted}; the codeload layout changed`);
  }
  run('mv', [extracted, join(work, `ffmpeg-${FFMPEG.version}`)]);
  run('tar', ['cJf', tarball, '-C', work, `ffmpeg-${FFMPEG.version}`]);
  rmSync(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// Two targets: the wasm pair and the JS loader are built by different rules. The
// loader (`dist/libav-<variant>.mjs`) is a minified copy of the versioned file and
// needs no FFmpeg, so it is quick.
const targets = `dist/libav-${LIBAV.version}-${VARIANT}.wasm.mjs dist/libav-${VARIANT}.mjs`;

console.log(`\nbuilding ${targets}`);
console.log('  a few minutes; the wasm links at the end');
if (AUDIO_ONLY) console.log('  --audio-only: video decoders excluded');

// FFmpeg's own build directory is removed first. Not for byte-identity (this
// build makes no such claim), but because a stale tree can link objects from a
// previous configuration and produce a decoder that does not match its recipe.
const clean = [
  `build/ffmpeg-${FFMPEG.version}/build-base-${VARIANT}`,
  'dist/libav-*.wasm.wasm',
  'dist/libav-*.wasm.mjs',
  `dist/libav-${LIBAV.version}-${VARIANT}.mjs`,
  `dist/libav-${VARIANT}.mjs`,
].map((p) => `rm -rf ${p}`).join(' && ');

run('bash', ['-lc', ['set -e', `cd ${JSON.stringify(CHECKOUT)}`, clean, `make ${targets}`].join(' && ')]);

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

const dist = join(CHECKOUT, 'dist');
const outputs = {
  // Renamed from `libav-<version>-iu.mjs`: the loader builds the paths to its own
  // wasm siblings from a name IT constructs, resolved relative to its own URL,
  // never from its own filename, so it works under any name.
  'libav.js': join(dist, `libav-${VARIANT}.mjs`),
  [`libav-${LIBAV.version}-${VARIANT}.wasm.mjs`]: join(dist, `libav-${LIBAV.version}-${VARIANT}.wasm.mjs`),
  [`libav-${LIBAV.version}-${VARIANT}.wasm.wasm`]: join(dist, `libav-${LIBAV.version}-${VARIANT}.wasm.wasm`),
};

// Remove ONLY our own outputs. `OUT_DIR` is `src/vendor/`, which also holds the
// committed `mediabunny.js` and its README, and `rm -rf` on the directory would
// delete those. Removing the three files by name is the difference between a
// clean rebuild and destroying committed work.
mkdirSync(OUT_DIR, { recursive: true });
for (const name of Object.keys(outputs)) {
  rmSync(join(OUT_DIR, name), { force: true });
}

let total = 0;
for (const [name, from] of Object.entries(outputs)) {
  const bytes = assertPresent(from, 10_000);
  copyFileSync(from, join(OUT_DIR, name));
  total += bytes;
  console.log(`  ${name.padEnd(36)} ${(bytes / 1024).toFixed(0).padStart(5)} KB`);
}

console.log(
  `\nwrote src/vendor/  (${(total / 1024 / 1024).toFixed(2)} MB, ${AUDIO_ONLY ? 'audio only' : 'audio and video'})`,
);
console.log('gitignored; `make release` ships it. `npm test` decodes a fixture with it');
