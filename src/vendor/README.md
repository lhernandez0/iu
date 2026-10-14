# `src/vendor/`

Generated. Do not edit by hand, run `node tools/build-vendor.mjs`.

`mediabunny.js` is a tree-shaken bundle of three MPL-2.0 packages, committed
because the release ZIP is built from `src/` alone and cannot depend on
`node_modules`:

- [mediabunny](https://mediabunny.dev), the container and conversion toolkit
- `@mediabunny/ac3`, the AC-3 and E-AC-3 coder (WebCodecs has neither)
- `@mediabunny/aac-encoder`, the AAC encoder (absent in some browsers)

They are bundled together because the coder packages import the bare specifier
`"mediabunny"`, which a `chrome-extension://` page cannot resolve. See
`THIRD-PARTY.md`.
