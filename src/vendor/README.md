# `src/vendor/`

Committed, generated, do not edit by hand:

- `mediabunny.js`, run `node tools/build-vendor.mjs`.

**Not here, and deliberately: the media decoder.** It is a compiled FFmpeg build
(a custom `libav.js` variant), built by `npm run vendor:libav` into this directory
and gitignored by name, so it is never committed. It is a build product rather
than a committed file. Building it needs `emcc`.

`mediabunny.js` is committed because the release ZIP is built from `src/` alone
and cannot depend on `node_modules`. See `THIRD-PARTY.md` for both.
