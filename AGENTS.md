# AGENTS.md

Guidance for AI coding agents working in this repository. [`README.md`](README.md)
says what the product is; this file is about how to work in it without breaking
something a test is holding.

## Commands

```bash
npm test                  # hermetic, ~1s, no browser, no network. The default loop.
npm run test:browser      # real Chromium, ~75s. Before a commit that changes wiring.
npm run test:conformance  # Matroska conformance; needs `npm run conformance:fetch` once.
npm run fixtures          # regenerate test/mkv/*.mkv (needs ffmpeg)
npm run ui                # Vite preview of the panel at 127.0.0.1:8099, for layout work
make release              # stage, lint, zip, verify -> build/*.zip
```

Only the first tier is in the default loop, on purpose. The others need a browser
or 190 MB of downloaded files, and putting them in `npm test` would make the fast
loop something to avoid.

## Rules a test enforces, so they are decisions and not style

Each of these is checked against the shipped source. A change that trips one is a
deliberate edit to several files at once, not something to route around:

- **No `storage.sync`.** Settings live in `storage.local`. The literal string fails
  `test/manifest.test.mjs`.
- **One external host, `youtube.com`.** No other absolute URL host may appear in
  `src/`, and no transport but `fetch`.
- **The permission list is pinned.** A new permission is a deliberate change to
  `manifest.json` and the test together.
- **Every file in `src/vendor/` must be named in `THIRD-PARTY.md`.**
- **The manifest `description` equals `package.json`'s and is at most 132
  characters**, because the store reads the manifest and rejects over 132.

## Conventions

- **No build step, and no runtime dependencies.** Plain ES modules loaded directly.
  The one generated file is `src/vendor/mediabunny.js`, rebuilt with
  `node tools/build-vendor.mjs`.
- **`const api = globalThis.browser ?? globalThis.chrome;` at each use site**, never
  a shared module. The two browsers disagree, and a shared shim hides where.
- **Comments explain why, especially where the obvious alternative was tried and
  rejected.** That register is deliberate. A comment that restates the code should
  be deleted.
- **JSDoc on exported and non-obvious functions**, with types, because the project
  is checked without a compiler.
- **No em dashes. Anywhere.** Not in code, comments, docs or commit messages. Use a
  comma, colon, semicolon, parentheses, or a new sentence.

## Never edit, because it is not ours

- `src/vendor/mediabunny.js` (MPL-2.0 code)
- `LICENSE`
- `src/learn/data/chinese.json`, `src/learn/data/japanese.json` (CC BY-SA
  derivatives of CC-CEDICT and JMdict)
- `test/conformance/`, `test/fixtures/`, `test/mkv/` (downloaded or generated)

`docs/` is gitignored and private. Shipped documents must not link into it, and
`test/manifest.test.mjs` fails if one does.

## AI use

This project is built with AI coding assistance and says so openly. We support
that use where it respects privacy and serves the common good, which is why the
extension collects nothing, has no server and no account, and why the source is
open under MIT.

The bar does not move for AI-assisted work. Nothing ships that a test does not
pin, no data leaves the browser, and a human reviews before merge.
