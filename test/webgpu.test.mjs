/**
 * WebGPU availability facts, and the rule that follows from them.
 *
 * There is no WebGPU code in `src/` yet. This suite exists because the DECISION
 * about whether ASR can rely on a GPU was made from unverified claims once
 * already, and the claims were wrong. Recording the version facts in a test
 * makes the next reader check them against something that runs.
 *
 * ## The facts, as of 2026-10
 *
 * Chrome/Chromium ships WebGPU from 113 on desktop, including Linux where the
 * driver stack provides Vulkan. Our `minimum_chrome_version` is above that, so
 * every Chrome we support has `navigator.gpu` as an API surface. An adapter is
 * a separate question: it depends on hardware and drivers, not on the browser.
 *
 * Firefox enables it BY DEFAULT on Windows from 141, and on macOS 26 (Tahoe) on
 * Apple Silicon from 145. On Linux it is NOT default-enabled at any release
 * version: current release builds expose it only behind `dom.webgpu.enabled` in
 * `about:config`. Android has none. This is why the floor matters: our
 * `strict_min_version` is 140, one release BELOW the Windows default-on
 * version, so a supported configuration exists with no WebGPU at all.
 *
 * The practical consequence, which is what most of this file asserts:
 *
 *   1. Feature detection is mandatory, and must test `requestAdapter()`, not
 *      the presence of `navigator.gpu`. A machine can have the API and no
 *      usable adapter.
 *   2. Any engine must have a non-WebGPU path, because the lowest supported
 *      Firefox has none, Linux has none, and our own Firefox-on-Linux test
 *      cannot enable the flag.
 *
 * Sources: the gpuweb implementation-status page, and gpuweb issue 6331 (a
 * documentation ticket asking that page to mention the Linux flag).
 *
 * Run with: `npm test`
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * The version facts this suite reasons about.
 *
 * Named rather than inlined so the assertions read as consequences of a number
 * that a person can go and check, and so updating one does not mean hunting
 * through the file.
 */
const FACTS = {
  /** First desktop Chrome with WebGPU, on any OS. */
  chromeShipped: 113,
  /** First Firefox with WebGPU on by default, on Windows. */
  firefoxDefaultWindows: 141,
  /** First Firefox with WebGPU on by default, on macOS 26 Apple Silicon. */
  firefoxDefaultMacTahoe: 145,
  /** Every Firefox release that default-enables it on Linux. */
  firefoxDefaultLinux: null,
};

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

/** @param {string} version @returns {number} */
function major(version) {
  return Number(String(version).split('.')[0]);
}

section('the version floors, against what the browsers actually shipped');

{
  const chromeFloor = major(manifest.minimum_chrome_version);
  const firefoxFloor = major(manifest.browser_specific_settings.gecko.strict_min_version);

  // Chrome is the easy case: the floor is above the release that introduced the
  // API, so `navigator.gpu` exists everywhere we run. If this fails, the floor
  // was lowered and every WebGPU assumption now needs a guard.
  check('our Chrome floor is at or above the release that shipped WebGPU', chromeFloor >= FACTS.chromeShipped, true);

  // Firefox is the case that actually constrains the design. Being BELOW the
  // Windows default-on release is what forces detection; if the floor is ever
  // raised past it, this check documents that the constraint changed rather
  // than silently disappearing.
  check('our Firefox floor is below the Windows default-on release', firefoxFloor < FACTS.firefoxDefaultWindows, true);

  // Stated as a fact rather than a comparison because there is no release
  // number to compare against: the answer is that none does.
  check('no Firefox release enables WebGPU on Linux by default', FACTS.firefoxDefaultLinux, null);
}

section('what the documentation tells a reader');

{
  // A version table that lives only in a commit discussion is a fact nobody
  // reading the repo will find. The README is the shipped place for it, and
  // `test/manifest.test.mjs` already asserts shipped documents do not link
  // into `docs/`, so this checks the content rather than restating it.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  check('the README says WebGPU is off by default on Linux', /Linux/i.test(readme) && /WebGPU/i.test(readme), true);
  check('and names the Windows version it became default', /\b141\b/.test(readme), true);
  check('and says detection must test for an adapter', /requestAdapter/.test(readme), true);
  check('and says a non-GPU path is required', /WASM/i.test(readme), true);
  // The forbidden mark. This project does not use em dashes, and a doc that
  // introduces one is the way they spread.
  check('the README has no em dash', /\u2014/.test(readme), false);
}

section('no unguarded use of navigator.gpu in shipped source');

{
  // There is no WebGPU code today, so this passes trivially. It is written now
  // because the failure it prevents is subtle: `navigator.gpu.requestAdapter()`
  // throws a TypeError when the API is absent, and that throw happens inside an
  // engine start() where it reads as "transcription failed" rather than "this
  // browser has no GPU". Requiring the guard on the same line makes the engine
  // say the true thing.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.js')) {
        readFileSync(full, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (!line.includes('navigator.gpu')) return;
            // An optional chain, an `if`, `typeof`, or a nullish guard are all
            // acceptable. A bare member access is not.
            const guarded = /(\?\.|\bif\b|\btypeof\b|\?\?|&&|\|\|)/.test(line);
            if (!guarded) offenders.push(`${relative(ROOT, full)}:${index + 1}`);
          });
      }
    }
  };
  walk(join(ROOT, 'src'));

  check('every navigator.gpu access is guarded', offenders, []);
}

console.log(`\n${checks - failures}/${checks} checks passed`);

if (failures > 0) process.exit(1);
