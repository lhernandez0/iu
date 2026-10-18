# AMO listing, IU Language Buddy

> **Status: draft, ready to paste.** Nothing has been submitted. Kept current so the
> AMO "Describe Add-on" form is a copy-paste rather than a scramble.

Why this is a separate file from `CHROMEWEBSTORE.md`: AMO asks for fields Chrome does
not, so this is not a translation of that one. Three of them exist only here, and the
load-bearing one is **Notes for Reviewers**, which is where the source-code
submission and the library links are pointed at.

---

## Reusable from the Chrome listing

These are identical on both stores and are already written in
[`CHROMEWEBSTORE.md`](CHROMEWEBSTORE.md). Do not copy them here; copy them from
there, so there is one copy of each:

- **Name**: `IU Language Buddy`
- **Summary** (AMO's short field): the short description in `CHROMEWEBSTORE.md`
- **Description**: the detailed description in `CHROMEWEBSTORE.md`
- **Screenshots**: deferred, see the note at the end

---

## Fields AMO asks for that Chrome does not

### Add-on URL

`iu-language-buddy`. Assigned from the name; unique.

### Categories (choose up to 2)

**Productivity** and **Other**.

As on Chrome, there is no "Education" category. `Productivity` is where study and
reading aids sit. `Other` is the honest second: the extension is a reading aid that
happens to live in the browser, and forcing it into a second existing category would
be less accurate than saying so.

Do **not** select an Android category. The extension has no Android support: there
is no sidebar on Firefox for Android, so `sidebar_action` has nothing to open. That
is also why no `gecko_android` floor is declared in the manifest.

### Support email

`lhernandez0@gmail.com`

### Support website

`https://github.com/lhernandez0/iu`

### License

**MIT**. The extension's own code, in `LICENSE`. It does **not** cover the bundled
dictionary data, which is CC BY-SA and separately attributed in `THIRD-PARTY.md`;
that distinction is stated in the detailed description and in the notice itself.

### This add-on is experimental

**No.** The extension is feature-complete for what it claims, and listing it as
experimental would reduce its visibility for a reason that does not apply.

### This add-on requires payment, non-free services or software, or additional hardware

**No.** Free, open source, no account, no server. The detailed description says so.

### This add-on has a privacy policy

**No**, and the box should stay unchecked, because nothing is transmitted off the
device. Firefox reads `data_collection_permissions` from the manifest, which
declares `required: ["none"]`, and shows "no data collected" on the install prompt.

A privacy policy is required when data is transmitted; none is. One is still worth
publishing eventually because it answers the question a suspicious user actually
asks, and `CHROMEWEBSTORE.md` says the same. If it is written, it goes here.

---

## Notes for Reviewers

This is the field that carries the two AMO-specific requirements. Paste:

```
The extension bundles one generated file, src/vendor/mediabunny.js, which is
minified. Source code and build instructions are attached as a separate source
package.

To rebuild that file:
  npm ci
  node tools/build-vendor.mjs
It should reproduce src/vendor/mediabunny.js byte for byte. The committed file's
SHA-256 is
4822d98bd58e08d2a82dfb01f6ce5a8b7310037eaf47b7d86436436f17c7d4ec

The package's README gives the build environment (Linux x86_64, Node 24, which
matches the default review environment) and the full instructions. Nothing else in
the extension is generated or transformed; the rest of src/ is hand-written plain
ES modules and is copied into the package unchanged.

Third-party libraries bundled, all MPL-2.0, all from the same repository, at the
release tags actually used:
  mediabunny 1.61.3            https://github.com/Vanilagy/mediabunny/tree/v1.61.3
  @mediabunny/ac3 1.61.4       https://github.com/Vanilagy/mediabunny/tree/v1.61.4/packages/ac3
  @mediabunny/dts 1.61.4       https://github.com/Vanilagy/mediabunny/tree/v1.61.4/packages/dts
  @mediabunny/aac-encoder 1.61.4  https://github.com/Vanilagy/mediabunny/tree/v1.61.4/packages/aac-encoder

The permission set differs between browsers, and each package declares only its own:
this build has no sidePanel permission, no side_panel key and no
background.service_worker, since Firefox uses sidebar_action and background.scripts.
The Chrome-facing store package declares the Chrome equivalents instead.

The bundled dictionary data (CC-CEDICT, JMdict, and the Korean sources) is not code
and is attributed in THIRD-PARTY.md, which ships in the package.
```

---

## What is NOT here yet

**Screenshots.** AMO wants at least one, 1280×800 recommended, and none are taken.
They are the last item on purpose: the UI is still changing, so a screenshot taken
now is a screenshot to retake. Everything else AMO asks for is answered above.
