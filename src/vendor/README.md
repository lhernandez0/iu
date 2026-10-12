# `src/vendor/`

Generated. Do not edit by hand.

- `mediabunny.js`, run `node tools/build-vendor.mjs`.
- `libav.js` and the two `libav-*` files, run `node tools/build-libav.mjs`.

Both are committed because the release ZIP is built from `src/` alone and
cannot depend on `node_modules` or a build machine. See `THIRD-PARTY.md`.
