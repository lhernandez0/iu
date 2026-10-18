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

**The extension runs in Firefox, in the test suite.** `test/browser/firefox.test.mjs`
installs it into a real Firefox and asserts, against Firefox's own add-on registry,
that it registers by id, receives a `moz-extension://` origin, and that its
**background script starts**. That last one is the assertion no other tier can make:
it proves Firefox read and executed `background.scripts`, a key Chromium does not
read at all, and a manifest Firefox ignored would report `NOT_STARTED` there.

Getting there is worth recording, because the obvious approach does not work. Firefox
launched by `firefox.launch()` or `launchPersistentContext()` never greets the
debugger client, so `web-ext`'s RDP install waits forever. `firefox.launchServer()`
leaves that server usable, and Playwright attaches to the same browser afterwards.
The one thing still not driven is the extension's own **pages**: Playwright's
`connect()` yields a browser with no contexts, and a context made afterwards cannot
navigate a `moz-extension://` origin. The Chromium tier drives those pages in full,
so the pages are covered; only their behaviour specifically under Firefox is not.
