/**
 * The codecs WebCodecs does not have, registered with mediabunny.
 *
 * ## Why this file exists
 *
 * A browser plays the codecs its own `WebCodecs` implementation carries. It has AAC,
 * Opus, H.264, VP9 and others. It has **no AC-3, E-AC-3 or DTS**, which is most of what
 * a film rip carries, which is why a file whose audio is one of those plays its picture
 * and emits **silence**, with no error to catch. Mediabunny ships official MPL-2.0
 * packages that supply exactly those codecs through its custom-coder API, and this
 * module registers them. See ADR 0013, which also reversed the earlier belief that DTS
 * had no permissively-licensed decoder. `@mediabunny/dts` is MPL-2.0 like the others.
 *
 * ## Registration is LAZY, and that is not a nicety
 *
 * **A registered coder takes precedence over the browser's own.** So registering the
 * AAC encoder unconditionally would make every encode go through WebAssembly and
 * **throw away the browser's native encoder**, which is faster and may be hardware
 * accelerated. The measurement in the plan put the WASM path at 28x real time, so the
 * native path is not required to hit the target, but discarding it would still be
 * discarding free work.
 *
 * So the encoder is registered **only when the browser cannot encode AAC**, which is
 * the documented pattern and the honest reading of "do the least work":
 *
 *     if (!(await canEncodeAudio('aac'))) registerAacEncoder();
 *
 * The AC-3 and DTS **decoders** are registered unconditionally, because there is no case
 * where a browser has either and we should defer to it: WebCodecs does not define them at
 * all, so the package is the only implementation that exists. If a browser ever gains
 * one, the same precedence rule means checking for it then, and the comment here is the
 * place that says so.
 *
 * ## What this module does NOT do
 *
 * It does not transcode. Registering a coder only tells mediabunny who can decode or
 * encode a codec; the conversion that uses them lives in `transcode-worker.js`. And a
 * file whose audio the browser can already play never touches any of this.
 */

import { canDecodeAudio, canEncodeAudio, registerAc3Decoder, registerAc3Encoder, registerDtsDecoder, registerDtsEncoder, registerAacEncoder } from '../vendor/mediabunny.js';

/**
 * Whether the coder registration has run, so it happens once per worker or page.
 *
 * `registerDecoder` and `registerEncoder` are global to the mediabunny module instance,
 * so registering twice is harmless but pointless, and this keeps the `canEncodeAudio`
 * probe (which constructs a real encoder and is not instant) to one call.
 */
let readyPromise = null;

/**
 * Register the coders mediabunny should use, once.
 *
 * Asynchronous because the AAC decision depends on a browser capability probe. Callers
 * `await` this before starting a conversion; the worker does exactly that.
 *
 * @returns {Promise<{aacEncoder: 'native'|'polyfill'}>} Which AAC encoder will be used,
 *   so the choice is reportable rather than invisible.
 */
export function registerCoders() {
  if (!readyPromise) {
    readyPromise = (async () => {
      // AC-3 and E-AC-3 have no WebCodecs implementation at all, so the package is the
      // only answer and it is registered unconditionally.
      registerAc3Decoder();
      registerAc3Encoder();

      // DTS is the same case as AC-3: WebCodecs has no DTS decoder, so the package is the
      // only answer and there is no native path to defer to. ADR 0013 put it in scope and
      // reversed ADR 0011's "no non-GPL decoder exists", which `@mediabunny/dts` (MPL-2.0)
      // makes false. The encoder is registered too, for symmetry and because a future
      // conversion target may want it, but DECODING is what makes a DTS film audible.
      registerDtsDecoder();
      registerDtsEncoder();

      // The AAC encoder exists in WebCodecs, but not in every browser, and a registered
      // custom encoder would take precedence over it. So it is registered only when the
      // probe says the browser cannot do it itself.
      let aacEncoder = 'native';
      try {
        if (!(await canEncodeAudio('aac'))) {
          registerAacEncoder();
          aacEncoder = 'polyfill';
        }
      } catch {
        // The probe constructs a real `AudioEncoder`, which can fail transiently. On any
        // error, prefer the polyfill to silence: the polyfill is known to work, and a
        // wrong guess here is a film with no sound.
        registerAacEncoder();
        aacEncoder = 'polyfill';
      }

      return { aacEncoder };
    })().catch((error) => {
      // Reset so a later attempt can retry: a transient failure should not poison every
      // conversion for the life of the page.
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

/**
 * Whether we can decode a codec, after making sure the coders are registered.
 *
 * The viewer asks this to decide whether an otherwise unplayable track is worth
 * converting, and the answer is wrong if it is asked before registration: `canDecodeAudio`
 * reports the browser's judgement plus the registered custom decoders, and a custom
 * decoder that has not been registered yet is simply not there. So the two steps are
 * welded together here rather than left to each caller to sequence correctly.
 *
 * @param {string} codec A mediabunny codec name, the spelling `listAudioTracks` uses.
 * @returns {Promise<boolean>}
 */
export async function canDecodeTrack(codec) {
  await registerCoders();
  return canDecodeAudio(codec);
}
