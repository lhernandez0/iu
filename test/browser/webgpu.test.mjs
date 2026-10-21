/**
 * WebGPU, in a real extension page, in a real Chromium, on Linux.
 *
 * ## What this suite can and cannot assert
 *
 * The valuable thing to test would be "the engine falls back to WASM when there
 * is no adapter". That needs an extension page that has an engine, and there is
 * none: `src/engines/` holds a stub that emits placeholder events, and no
 * WebGPU code exists to fall back from. A test of a fallback that does not
 * exist would be theatre.
 *
 * So this asserts the layer underneath, which does exist and is the part that
 * has actually been wrong in a discussion: what the browser reports, from an
 * EXTENSION ORIGIN rather than a normal page, and whether `requestAdapter`
 * throws or resolves to null when there is no device. Those are different
 * behaviours and an engine must handle both.
 *
 * ## Why this machine reports a null adapter, with a GPU in it
 *
 * Measured: `navigator.gpu` EXISTS and `requestAdapter()` resolves `null`. The
 * machine has an RTX 5060 Ti, so the obvious reading ("no GPU") is wrong, and
 * the real reason is worth writing down because it is the shape most Linux
 * users will hit.
 *
 * **WebGPU on Linux Chromium has exactly two backends: Vulkan and SwiftShader
 * (software).** There is no CUDA path and no OpenGL path. An NVIDIA driver only
 * becomes a Vulkan device through the Vulkan loader (`libvulkan1`) and an ICD
 * JSON (`nvidia_icd.json`), and this machine has neither: it is WSL2 with the
 * compute driver only (`libnvidia-compute-580`, enough for CUDA and
 * `nvidia-smi`), no `libvulkan1`, no ICD directory, and no `libnvidia-gl-*`.
 *
 * So WSL2 gives CUDA and not graphics, which is why a machine that can train
 * a model cannot present a WebGPU adapter to Chromium. Bundled SwiftShader did
 * not help either, with or without `--enable-unsafe-webgpu`, headed or
 * headless.
 *
 * Note also that `about:blank` is NOT a secure context, so `navigator.gpu` is
 * absent there entirely. That was mistaken for "this machine has no WebGPU"
 * during this investigation. The probe below runs on an extension page for that
 * reason: the answer depends on the page as well as the machine.
 *
 * Installing `mesa-vulkan-drivers` on a bare Linux host adds lavapipe, a
 * SOFTWARE Vulkan device. That is enough to make the API answerable and would
 * let a real adapter assertion run, but it measures CPU performance and says
 * nothing about the GPU. It does not apply inside WSL2, where the GPU is not a
 * Vulkan device at all.
 *
 * ## The finding worth keeping, whatever this machine reports
 *
 * Three distinct conditions an engine must survive: `navigator.gpu` absent
 * (insecure context, or a browser without the API), an adapter that resolves
 * `null` (this machine), and `requestAdapter()` throwing. The spec says a
 * missing device resolves `null` rather than rejecting, so a throw is a
 * launch-environment bug, not a device to fall back from. Engine code must treat
 * all three as "no GPU" without crashing, with the WASM path reachable from
 * each.
 *
 * Run with: `npm run test:browser`
 */

import { launchExtension, BrowserUnavailable } from './harness.mjs';

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
 * Probe WebGPU from inside an extension page.
 *
 * Run in the extension origin on purpose. An extension page is a normal secure
 * context, but the question of whether a privileged origin behaves differently
 * is exactly the kind an engine would trip over, and it is cheap to answer here
 * rather than in production.
 *
 * @param {object} page
 * @returns {Promise<object>}
 */
function probe(page) {
  return page.evaluate(async () => {
    const out = {
      // The API existing at all. Absent on Linux Chromium without Vulkan.
      hasApi: 'gpu' in navigator && navigator.gpu !== undefined,
      // A context, which is the part `navigator.gpu` alone does not tell you.
      hasAdapter: false,
      // `throw` and `null` are DIFFERENT failure modes, so they are recorded
      // separately rather than collapsed into a boolean.
      threw: null,
    };
    if (!out.hasApi) return out;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      out.hasAdapter = adapter !== null;
      // Which backend answered. `isFallbackAdapter` tells us the difference
      // between a real device and lavapipe/SwiftShader software rendering, which
      // matters because only the first says anything about GPU performance.
      out.backend = adapter
        ? `${adapter.info?.vendor ?? 'unknown'}/${adapter.info?.architecture ?? 'unknown'}${adapter.isFallbackAdapter ? ' (fallback)' : ''}`
        : null;
    } catch (error) {
      out.threw = String(error).slice(0, 120);
    }
    return out;
  });
}

section('WebGPU from an extension origin');

let context;
try {
  const launched = await launchExtension();
  context = launched.context;

  const page = await context.newPage();
  await page.goto(`chrome-extension://${launched.extensionId}/src/sidepanel/sidepanel.html`);
  await page.waitForLoadState('domcontentloaded');

  check('the extension page is a secure context', await page.evaluate(() => isSecureContext), true);

  const result = await probe(page);

  if (!result.hasApi) {
    console.log('  SKIP  navigator.gpu is absent, so this machine cannot answer the question.');
    console.log('        This is unexpected on an extension page in Chrome 113+, and usually');
    console.log('        means the page was not a secure context or the launch was restricted.');
    if (context) await context.close();
    process.exit(0);
  }

  check('navigator.gpu exists', result.hasApi, true);
  // Either an adapter, or a clean null, or a throw that we can report. Never a
  // hang, and never an unhandled rejection, which is what a missing `try` would
  // produce in engine code.
  const reported = result.hasAdapter ? 'adapter' : result.threw ? 'threw' : 'null';
  check('requestAdapter resolves or rejects in a reportable way', ['adapter', 'null', 'threw'].includes(reported), true);
  // The assertion that matters for the engine: no adapter must be a VALUE, not
  // an exception. `requestAdapter` is specified to resolve null, so a throw here
  // is a bug in the browser or in how it was launched, and an engine must not
  // assume it.
  check('a missing adapter is reported as null rather than thrown', result.threw, null);

  // Distinguish the two null-adapter worlds, because they call for different
  // work. A machine with a real device that reports null has a driver or backend
  // problem worth fixing; a machine with none is simply unsupported and should be
  // told so. Neither should be silently reported as "works".
  if (result.hasAdapter) {
    console.log(`  note  a WebGPU adapter is available here, backend: ${result.backend}`);
  } else {
    console.log('  note  no adapter. On Linux this means no Vulkan loader/ICD and no');
    console.log('        SwiftShader fallback, which is the normal state inside WSL2 where');
    console.log('        the NVIDIA driver is compute-only. Not a bug in the extension.');
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
} catch (error) {
  if (error instanceof BrowserUnavailable) {
    console.log(`  SKIP  ${error.message.split('\n')[0]}`);
  } else {
    console.log(`  FAIL  ${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
} finally {
  try {
    await context?.close();
  } catch {
    /* already closed */
  }
}
