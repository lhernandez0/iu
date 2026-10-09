/**
 * Checks on the extension manifest and the assets it points at.
 *
 * This exists because of a real defect: `manifest.json` declared no icon at all,
 * so Chrome drew a letter tile from the extension name and rendered only the
 * first character — `IU` became a toolbar tile reading `I`. Nothing failed; a
 * missing icon is invisible in a directory listing and only shows up in Chrome.
 *
 * The checks here are deliberately shallow. They cannot judge whether the artwork
 * is legible at 16px — that is a visual question for a person — but they can
 * catch the failure mode that actually happened: a manifest pointing at a path
 * that does not exist, or at a file that is not the size it claims.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(ROOT, 'manifest.json');

let failures = 0;
let checks = 0;

/** @param {string} name @param {any} actual @param {any} expected */
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  pass  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`);
    failures++;
  }
}

/** @param {string} name */
function section(name) {
  console.log(`\n${name}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/** Sizes Chrome documents for `icons`, and the ones it uses day to day. */
const REQUIRED_ICON_SIZES = ['16', '32', '48', '128'];

/**
 * Read a PNG's real dimensions from its header.
 *
 * Parsed rather than assumed, because the point is to catch a file that is not
 * what its name says. A 128px icon saved as icon-16.png would render blank or
 * squashed, and `existsSync` would be perfectly happy with it.
 *
 * @param {string} file
 * @returns {{ok: boolean, width: number, height: number}}
 */
function pngSize(file) {
  const bytes = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    return { ok: false, width: 0, height: 0 };
  }
  // The IHDR chunk is first, so width and height sit at fixed offsets.
  return { ok: true, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

section('the manifest declares an icon, so no letter tile is used');

// The exact bug: with no `default_icon`, Chrome falls back to a generated tile
// and draws only the first letter of the name.
check('the action has a default_icon', Boolean(manifest.action?.default_icon), true);
check('and a top-level icons block', Boolean(manifest.icons), true);
check('the toolbar icon is 16px', Boolean(manifest.action?.default_icon?.['16']), true);

section('every declared icon exists and is the size it claims');

for (const size of REQUIRED_ICON_SIZES) {
  const declared = manifest.icons?.[size];
  check(`icons["${size}"] is declared`, typeof declared, 'string');

  if (typeof declared === 'string') {
    const file = join(ROOT, declared);
    // `existsSync` before reading, so a missing file reports as missing rather
    // than as a stack trace from `readFileSync`.
    check(`icons["${size}"] exists on disk`, existsSync(file), true);
    if (existsSync(file)) {
      const { ok, width, height } = pngSize(file);
      check(`icons["${size}"] is a real PNG`, ok, true);
      // Square and exactly the declared size. An icon that is the wrong size is
      // silently stretched by Chrome, which is the kind of thing nobody notices
      // until it looks wrong on one particular surface.
      check(`icons["${size}"] is ${size}x${size}`, `${width}x${height}`, `${size}x${size}`);
    }
  }
}

section('the action icon is one of the declared icons, not a separate asset');

for (const [size, path] of Object.entries(manifest.action?.default_icon ?? {})) {
  const declared = manifest.icons?.[size];
  // A second set of files for the toolbar would be a second thing to keep in
  // sync. Pointing at the same PNGs means one source of truth.
  check(`action.default_icon["${size}"] matches icons["${size}"]`, path, declared);
}

section('the icon source is committed, so the PNGs can be regenerated');

// The PNGs are committed because there is no build step, but a set of binaries
// with no source is unmaintainable — nobody can recolour it. The SVG is what
// makes them reproducible.
check('icons/icon.svg exists', existsSync(join(ROOT, 'icons', 'icon.svg')), true);
check('the generator exists', existsSync(join(ROOT, 'tools', 'make-icons.mjs')), true);

section('package.json and the manifest describe the extension the same way');

{
  // The store reads the manifest's description; everyone else reads package.json.
  // They said different things for a while — the manifest had been rewritten for
  // publication while package.json still called the project "Personal-use Chrome
  // extension", which is the framing that was deliberately removed everywhere
  // else. Two descriptions of one product drift because nothing compares them.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  check('the descriptions match', pkg.description, manifest.description);
  // The store rejects a description over 132 characters, and it reads the
  // MANIFEST — so this is the one place the limit has to be enforced.
  check('and fit the store limit', manifest.description.length <= 132, true);
  // A description that disagrees with the version is a description of a different
  // product. Both are bumped together at release time or not at all.
  check('and the versions match', pkg.version, manifest.version);
}

section('shipped documents do not point at things a reader cannot have');

{
  // `docs/` is gitignored — planning notes, ADRs, the roadmap. They are ours and
  // deliberately private, which means a tracked file that references one publishes
  // a pointer to something a reader of the repository cannot open.
  //
  // This has gone wrong three times: two README links to design-decisions files
  // that 404 on GitHub, and then three "see ADR 0007" references in
  // CHROMEWEBSTORE.md. Each was found by a person noticing, not by anything
  // running. The fix is one grep, so it should never have been a person's job.
  //
  // Scanned rather than imported: the point is the FILE as a reader receives it,
  // and the failure mode is text in prose that no module ever evaluates.
  const SHIPPED = ['README.md', 'CHROMEWEBSTORE.md', 'TESTING.md', 'THIRD-PARTY.md'];
  // A path into a gitignored directory, or an ADR reference. ADRs live in docs/,
  // so naming one is the same mistake written a different way.
  const PRIVATE = /docs\/(design-decisions|private)\/|\bADR\s*\d{3,4}\b/;

  const offenders = [];
  for (const file of SHIPPED) {
    const full = join(ROOT, file);
    if (!existsSync(full)) continue;
    readFileSync(full, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (PRIVATE.test(line)) offenders.push(`${file}:${index + 1}`);
      });
  }

  check('no shipped document references a private doc or an ADR', offenders, []);

  // The other half, and the one a reader actually hits: a relative link that does
  // not resolve. A link to a tracked file is fine; a link to `docs/` is not.
  const broken = [];
  for (const file of SHIPPED) {
    const full = join(ROOT, file);
    if (!existsSync(full)) continue;
    for (const match of readFileSync(full, 'utf8').matchAll(/\]\(([A-Za-z0-9._/-]+)\)/g)) {
      const target = match[1];
      if (target.startsWith('http') || target.startsWith('#')) continue;
      if (!existsSync(join(ROOT, target))) broken.push(`${file} -> ${target}`);
    }
  }
  check('and every relative link in them resolves', broken, []);
}

section('shipped source can only reach youtube.com, and only over fetch');

{
  // The README tells users the extension collects nothing and talks to one host.
  // That is a claim about the code, so it has to be a check on the code.
  //
  // This is not hypothetical: an extension's privacy story never breaks in one
  // commit. It breaks when a helpful error reporter, a remote word list, or a
  // "check for updates" ping is added to one file at 1am and nothing objects.
  // By the time it is noticed the store listing, the policy and the README have
  // all been wrong for a release. ADR 0008 is the decision; this is enforcement.
  //
  // Deliberately narrow. It does not try to prove there is no way to make a
  // request — it checks the three things that actually change the answer:
  // which transport is used, which host appears, and how many call sites exist.

  const OUTBOUND = 'fetch(';

  /** Every `.js` under a directory, recursively. */
  function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  const sources = walk(join(ROOT, 'src'));

  /** Lines that are code, not prose about code. A comment naming `fetch` is not
   *  a call, and counting one would make the inventory below drift for no reason
   *  — but blanking comments properly means parsing strings, and every URL here
   *  contains `//`, so a naive stripper would truncate the line it is on. */
  function codeLines(text) {
    return text
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      });
  }

  // 1. No transport other than `fetch`. Each of these can carry data off the
  //    machine, and none is used today, so any appearance is a new decision
  //    rather than an accident.
  const FORBIDDEN = /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bimportScripts\b|navigator\.send/;
  const transports = [];
  for (const file of sources) {
    for (const line of codeLines(readFileSync(file, 'utf8'))) {
      if (FORBIDDEN.test(line)) transports.push(`${relative(ROOT, file)}: ${line.trim()}`);
    }
  }
  check('no transport but fetch appears in src/', transports, []);

  // 2. Every absolute URL named in src/ resolves to youtube.com. A URL whose
  //    host is computed cannot be checked, so it fails rather than passing
  //    unexamined — that is the whole point of listing hosts.
  const hosts = new Set();
  const computed = [];
  for (const file of sources) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const match of line.matchAll(/https?:\/\/([A-Za-z0-9_.-]*)/g)) {
          const host = match[1];
          // An empty host means the next character was `$` or `{` — a host built
          // from a variable at runtime, which this check cannot vouch for.
          if (host) hosts.add(host);
          else computed.push(`${relative(ROOT, file)}:${index + 1}`);
        }
      });
  }
  check('every absolute URL host in src/ is youtube.com', [...hosts].sort(), ['www.youtube.com']);
  check('and no host is built at runtime', computed, []);

  // 3. The call sites are a short, named list. Adding one changes a number here,
  //    which fails this test and lands the author in this file, reading why.
  //    A count is a blunt instrument and is chosen for that: it cannot be
  //    accidentally satisfied, and it is honest about being a list rather than
  //    pretending to be dataflow analysis.
  //
  //      wordlist.js        2 — bundled dictionary JSON, read through
  //                            `runtime.getURL`. Local files, not the network.
  //      youtube-content.js 1 — `fetchBounded()`, the caption track.
  //      reader/reader.js   1 — the same bundled dictionary JSON. The reader marks
  //                            its own captions with the shared marking rules, so
  //                            it needs the dictionary too — and it fetches it from
  //                            `runtime.getURL`, i.e. from the extension's own
  //                            package, never the network.
  const expected = {
    'content/youtube-content.js': 1,
    'learn/wordlist.js': 2,
    'reader/reader.js': 1,
  };
  const found = {};
  for (const file of sources) {
    const count = codeLines(readFileSync(file, 'utf8')).filter((line) =>
      line.includes(OUTBOUND),
    ).length;
    if (count) found[relative(join(ROOT, 'src'), file)] = count;
  }
  // Rebuilt in sorted key order: `check` compares serialised values, and object
  // key order follows readdir order, which is not guaranteed to be stable.
  const ordered = Object.fromEntries(Object.entries(found).sort(([a], [b]) => (a < b ? -1 : 1)));
  check('the fetch call sites are the ones we know about', ordered, expected);

  // 4. Settings do not leave the machine. `storage.sync` would put them in a
  //    Google account — the user's own, but still not "your browser".
  const sync = [];
  for (const file of sources) {
    if (/\bstorage\.sync\b/.test(readFileSync(file, 'utf8'))) sync.push(relative(ROOT, file));
  }
  check('nothing uses storage.sync', sync, []);
}

section('the permission list is exactly what the privacy claim describes');

{
  // The check above scans `src/` for requests. It says nothing about what the
  // extension is ALLOWED to do, which lives in the manifest — and the privacy
  // section makes claims about both. So the permission list needs its own check,
  // because without one it can grow silently: expanding `host_permissions` to
  // `https://*.example.com/*` and `file:///*` left this suite at 33/33.
  //
  // `file:///*` is the one that matters. It is how an extension reads files off
  // someone's disk without them picking a file, and it would make the privacy
  // section false while every scan of `src/` still passed.
  //
  // **Adding a provider means editing this list on purpose.** That is the
  // feature, not friction: "we read one host" is a promise, and a promise you
  // can widen by accident is not one. If you are here to add a second site, the
  // edit is one line plus a note in README.md's privacy section — and the test
  // failing is what tells you to write it down.
  check('host_permissions is exactly the YouTube pattern', manifest.host_permissions, [
    'https://*.youtube.com/*',
  ]);

  // The README also says no page can reach into the extension, which is a
  // statement about `web_accessible_resources` — the only thing that changes it.
  // There is no need for one: the panel and any future reader are opened by the
  // extension, and `tabs.create(runtime.getURL(...))` does not require it.
  check('nothing is web_accessible', Boolean(manifest.web_accessible_resources), false);

  // Each of these widens what the extension can do on its own initiative, and
  // none is used. `tabs` would expose `url`/`title` on every tab; without it the
  // worker sees a tab's URL only because it already holds host permission for
  // that host, which is the narrower arrangement.
  const WIDENING = ['activeTab', 'tabs', 'unlimitedStorage'];
  const requested = WIDENING.filter((name) => (manifest.permissions ?? []).includes(name));
  check('no permission is requested that widens reach', requested, []);

  // The whole list, pinned. This is the guard that would have caught the
  // `contextMenus` mistake: the design claimed the action menu cost no
  // permission, the claim was wrong, and nothing here was asserting the list —
  // so the only symptom was a menu item that was silently absent.
  //
  // A new permission now has to be added HERE, deliberately, which is the point.
  // `contextMenus` is included because the toolbar icon's menu is how a source is
  // opened; it adds no host access and no tab visibility.
  check('the permission list is exactly what we have justified', manifest.permissions, [
    'storage',
    'sidePanel',
    'scripting',
    'webNavigation',
    'contextMenus',
  ]);
}

section('every provider script is declared in the manifest, or it is never injected');

{
  // `src/common/providers.js` is the list of sites we can read. The manifest is
  // the list of sites we are allowed to read, and nothing compares them.
  //
  // There is a fourth copy of that knowledge, which is the risk: a provider's
  // scripts are ALSO named here, in `content_scripts[].js`. So adding a site
  // means editing two files, and forgetting the second gives a provider that
  // resolves, injects nothing on a fresh load, and reports "no captions" — the
  // same silent failure shape ADR 0003 was written to remove.
  //
  // Read from the source text rather than imported: `providers.js` is an ES
  // module with a regex in it, and the question is only which paths it names.
  const source = readFileSync(join(ROOT, 'src', 'common', 'providers.js'), 'utf8');
  const declared = source
    .split('\n')
    .flatMap((line) => [...line.matchAll(/'(src\/content\/[^']+)'/g)].map((match) => match[1]));
  const injected = (manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []);
  const missing = declared.filter((file) => !injected.includes(file));
  check('every provider script appears in content_scripts', missing, []);

  // The reverse direction, and the one that catches a real mistake: a script
  // injected into a site that no provider claims. It would run on every matching
  // page and report nothing, which is a provider's job done by nobody.
  const claimed = new Set(declared);
  const orphaned = injected.filter((file) => !claimed.has(file));
  check('and no script is injected for a site no provider claims', orphaned, []);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;