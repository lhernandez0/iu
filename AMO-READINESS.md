# Firefox (AMO) submission readiness

A one-paragraph status note. The full plan, with the requirement-by-requirement
table and the measurements it is based on, is a private working document.

The extension is structurally close to AMO-ready and the gap is mostly paperwork.
`make lint` reports **0 errors** and 4 classified warnings, the manifest already
declares Firefox properly (`browser_specific_settings.gecko`, `sidebar_action`,
`background.scripts`, and `data_collection_permissions.required: ["none"]`), and
the code feature-detects the panel API that differs between browsers. The one real
requirement is **source-code submission**: `src/vendor/mediabunny.js` is a
minified bundle, so Mozilla requires the original source plus instructions that let
a reviewer rebuild it to a byte-identical file. That rebuild is **verified to
reproduce exactly today** (`node tools/build-vendor.mjs`, hash
`4822d98bd58e08d2a82dfb01f6ce5a8b7310037eaf47b7d86436436f17c7d4ec`), so what is
missing is the packaging: a source archive, a reviewer-facing README naming the
build command and the toolchain, and a target that keeps the byte-identical check
true in CI. After that come the third-party library links pinned to release tags,
raising `strict_min_version` from 128 to 140 to match the data-consent feature, and
the honest gap that **nothing currently runs the extension in Firefox**: the
browser tier is Chromium-only, and the sidebar API is the mechanism most likely to
differ. Screenshots and the public listing are deliberately last, because the UI is
still changing.
