# Source code for the IU Language Companion extension

This package accompanies the extension version it is submitted with. It exists
because the extension ships one **minified** file, and Mozilla's review requires the
original source and a build that reproduces that file exactly.

Everything else in the extension is hand-written, unminified, and already readable
in the extension's own package. There is no other generated code.

## What is generated

| Generated file | Produced by | Why |
| --- | --- | --- |
| `src/vendor/mediabunny.js` | `node tools/build-vendor.mjs` | Bundles four npm packages into one ESM file. |

Nothing else in `src/` is generated or transformed. There is no TypeScript, no
transpiler, and no other bundler in the build.

### Why the bundle cannot simply be the packages

The extension is loaded from `chrome-extension://` and runs as plain ES modules
with no module resolution step. A bare specifier such as `import { Input } from
'mediabunny'` cannot be resolved in that context, so the library and the coder
packages that extend it have to be combined into one file that resolves its own
imports. The file is committed to the repository because the release package is
assembled from `src/` alone and cannot depend on `node_modules/`.

## How to build it

From a clean checkout of the source directory:

```
npm ci
node tools/build-vendor.mjs
```

That is the complete build. `npm ci` installs exactly the versions in
`package-lock.json`, and `tools/build-vendor.mjs` writes
`src/vendor/mediabunny.js` in place.

Then compare it with the file in the extension package. It should be identical:

```
sha256sum src/vendor/mediabunny.js
```

The committed file's hash is:

```
4822d98bd58e08d2a82dfb01f6ce5a8b7310037eaf47b7d86436436f17c7d4ec
```

### Confirming the whole extension

There is nothing else to build. The rest of `src/` is copied into the extension
package unchanged, so the extension can be reassembled by copying `manifest.json`,
`icons/` and `src/` over the built file.

## Build environment

| | |
| --- | --- |
| OS | Linux, x86_64 (Ubuntu lineage) |
| Node.js | **24** (pinned in `.nvmrc`) |
| npm | 11 (the version shipping with Node 24) |

**These match Mozilla's default review environment** (Ubuntu, Node 24), so no
environment divergence needs accounting for. The build was also verified under
Node 26 and reproduced the same bytes; the pins above are what the project targets.

The build reads only `tools/build-vendor.mjs`, the sources it imports, and
`node_modules/`. It makes no network requests.

## Third-party libraries

The bundle contains four packages, all under the Mozilla Public License 2.0, all
from the same repository, `https://github.com/Vanilagy/mediabunny`. Links are to the
release tags actually installed:

| Package | Version | Source at that tag |
| --- | --- | --- |
| `mediabunny` | 1.61.3 | https://github.com/Vanilagy/mediabunny/tree/v1.61.3 |
| `@mediabunny/ac3` | 1.61.4 | https://github.com/Vanilagy/mediabunny/tree/v1.61.4/packages/ac3 |
| `@mediabunny/dts` | 1.61.4 | https://github.com/Vanilagy/mediabunny/tree/v1.61.4/packages/dts |
| `@mediabunny/aac-encoder` | 1.61.4 | https://github.com/Vanilagy/mediabunny/tree/v1.61.4/packages/aac-encoder |

Note that `mediabunny` itself is pinned to **1.61.3** while the three coder packages
are **1.61.4**, so the links point at two different tags. Both tags exist in the
repository.

The full dependency list, including the development-only packages, is in
`package.json` and pinned in `package-lock.json`, which is included here.

### Licences of other bundled material

The extension also bundles **dictionary data** from CC-CEDICT, JMdict (EDRDG) and
Korean sources. That data is not code and is not part of the build above; its
licences and attributions are documented in `THIRD-PARTY.md` and
`THIRD-PARTY-NOTES.md` in the extension package.

## About the minification

The file is minified by `esbuild` with `minify: true`. This reduces variable names
and removes whitespace; it does not obscure control flow or conceal behaviour, and
the source above reproduces it byte for byte. If a readable copy is easier to
review, running `node tools/build-vendor.mjs` with `minify` set to `false` produces
a larger but unminified version of the same code.
