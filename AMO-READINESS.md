# Firefox (AMO) submission readiness

A status note. The full plan, with the requirement-by-requirement table and the
measurements it is based on, is a private working document.

The one hard requirement was **source-code submission**, because
`src/vendor/mediabunny.js` is minified. That is implemented: `make source` produces
the package a reviewer rebuilds from, `tools/amo/AMO-SOURCE.md` becomes its README,
and `make verify-source` proves the rebuild is byte-identical to the committed file
(`4822d98b…`, checked under Node 24, the version Mozilla's reviewers use). The
package was verified end to end by extracting it and rebuilding from the extracted
copy, which is exactly the reviewer's procedure.

The **per-browser build target** landed too. `make release TARGET=firefox` emits a
manifest with no `sidePanel` permission, no `side_panel` and no
`background.service_worker`, taking `web-ext lint` from 4 warnings to 1; the one
that remains is Android-only and explained in `tools/check-lint.mjs`. The linter now
**fails** on an unclassified warning rather than printing it, so the accepted set
cannot grow quietly.

**What is left.** Screenshots, and only screenshots. Everything else AMO asks for is
written: `AMO-LISTING.md` holds the listing fields, including the three that exist
only on AMO (up to two categories, support contact, and Notes for Reviewers, where
the source package and the library links are pointed at). Screenshots are last
because the UI is still changing, so one taken now is one to retake.

There is also one honest gap: **no test executes the extension in Firefox.**
`test/browser/firefox.test.mjs` attempts a real Firefox and SKIPs with its reason on
this machine, where Firefox will not load an unsigned sideloaded extension;
`test/firefox-manifest.test.mjs` covers the cross-browser seam structurally in the
meantime. `web-ext run` does report the extension installing, so
this is a gap in the test harness rather than in the extension.
