/**
 * Licence checks.
 *
 * Two jobs, both about things that rot silently:
 *
 *   1. Every dependency's licence is on an allowlist. A copyleft dependency
 *      arriving transitively through a dev tool is exactly the kind of thing
 *      nobody notices until it matters, and it costs one file read to catch.
 *   2. The third-party notices that attribution requires actually exist, and the
 *      dictionary still declares its licence where the artefact can be checked.
 *
 * It does NOT attempt to interpret licences. It compares strings against a list a
 * human maintained, and says so when something is not on it, a check that guesses
 * would be worse than none.
 *
 * Offline and dependency-free: reads `node_modules` and files, nothing else.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

/**
 * Licences we are content to depend on.
 *
 * All permissive, plus MPL-2.0, which is file-level copyleft and imposes nothing
 * on this project: it is present only through Vite, is development-only, is never
 * bundled, and is unmodified. Anything else must be a deliberate decision, which
 * is why it fails rather than warning.
 */
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'MPL-2.0',
]);

/**
 * Every package.json under node_modules, read directly.
 *
 * Walked rather than resolved through `npm ls` so this needs no network and no
 * dependency of its own, and so it sees the transitive packages, which is where a
 * surprise would actually come from.
 *
 * @param {string} dir
 * @param {Map<string, {version: string, licence: string}>} found
 */
function collect(dir, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);

    // Scoped packages sit one level deeper.
    if (entry.name.startsWith('@')) {
      collect(child, found);
      continue;
    }

    const manifest = join(child, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        if (parsed.name && parsed.version) {
          found.set(parsed.name, {
            version: parsed.version,
            licence:
              typeof parsed.license === 'string' ? parsed.license : (parsed.license?.type ?? '(none)'),
          });
        }
      } catch {
        // A malformed manifest is npm's problem, not a licence finding.
      }
    }

    const nested = join(child, 'node_modules');
    if (existsSync(nested)) collect(nested, found);
  }
}

section('every installed dependency carries a licence we have accepted');

{
  const found = new Map();
  collect(join(ROOT, 'node_modules'), found);

  if (!found.size) {
    // A fresh clone runs `npm test` before `npm i`, and that must not be a failure.
    console.log('  (no node_modules, nothing to check)');
  } else {
    const unexpected = [...found.entries()]
      .filter(([, info]) => !ALLOWED.has(info.licence))
      .map(([name, info]) => `${name}@${info.version} = ${info.licence}`);

    check(`all ${found.size} packages are on the allowlist`, unexpected, []);

    const unlicensed = [...found.entries()]
      .filter(([, info]) => info.licence === '(none)')
      .map(([name]) => name);
    check('no package is missing a licence field', unlicensed, []);
  }
}

section('the extension itself ships no dependencies');

{
  // The claim worth protecting, corrected: the shipped extension is our code PLUS
  // the one vendored bundle, and that bundle carries an obligation.
  //
  // It used to read "our code and nothing else", which was true when it was written.
  // `src/vendor/mediabunny.js` makes it false, a tree-shaken MPL-2.0 bundle, committed
  // because the release ZIP is built from `src/` alone and cannot resolve
  // `node_modules`. So the guard changes with the fact rather than being deleted: it
  // now checks that the vendored code is NAMED where the obligation says it must be.
  //
  // `dependencies` staying empty is still worth asserting. It is what keeps the
  // shipped code from acquiring modules the packaging step would silently drop,
  // anything the extension needs at runtime has to be committed, not resolved.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  check('there are no runtime dependencies', pkg.dependencies ?? {}, {});
  // No `web_accessible_resources` means no bundled third-party asset is served.
  check('the manifest exposes no resources', manifest.web_accessible_resources ?? undefined, undefined);
  // The CSP, which used to be asserted ABSENT and is now asserted to be exactly what
  // the media decoder needs and nothing more. The decoder is WebAssembly, and MV3
  // refuses to instantiate wasm without `wasm-unsafe-eval`, so the policy is a real
  // requirement rather than a drift. It is checked strictly: no `unsafe-inline`, no
  // remote source, because a loose policy here would silently allow far more than the
  // decoder needs.
  const policy = manifest.content_security_policy?.extension_pages ?? '';
  check('the CSP allows WebAssembly', policy.includes("'wasm-unsafe-eval'"), true);
  check('and allows no inline script', policy.includes("'unsafe-inline'"), false);
  check('and allows no remote script source', /https?:/.test(policy), false);

  // Every vendored file must be attributed, or the licence obligation is unmet.
  //
  // EVERY file, not just the `.js` ones. It used to filter on `.js`, which was
  // right when `mediabunny.js` was the only vendored file and wrong the moment a
  // library split itself across a loader, a glue file, and a `.wasm` binary. That
  // was the compiled decoder, now retired, but the filter is the failure this
  // check exists to prevent and it stays strict. `README.md` is generated by the
  // build scripts and is not third-party code.
  const vendorDir = join(ROOT, 'src', 'vendor');
  if (existsSync(vendorDir)) {
    const bundled = readdirSync(vendorDir).filter((name) => name !== 'README.md');
    const notices = readFileSync(join(ROOT, 'THIRD-PARTY.md'), 'utf8');
    check('there is a vendored bundle to account for', bundled.length > 0, true);
    for (const name of bundled) {
      // By name, because "some third-party code exists" is not attribution.
      check(`${name} is named in THIRD-PARTY.md`, notices.includes(name), true);
    }
    check('and the MPL-2.0 obligation is stated', /MPL-2\.0/.test(notices), true);
  }

  // The media decoder used to be a COMPILED build product, an FFmpeg variant
  // (ADR 0011), and this section asserted its recipe named the upstream, the
  // licence and the pinned revisions. ADR 0013 retired that: the codecs come from
  // published MPL-2.0 packages (`@mediabunny/ac3`, `@mediabunny/dts`,
  // `@mediabunny/aac-encoder`) that are bundled INTO `mediabunny.js`, so there is no
  // separate artifact and no separate attribution entry. What must still hold is that
  // the bundle names every package inside it, or a part of the shipped code is
  // unattributed.
  //
  // Asserted from THIRD-PARTY.md rather than from the bundle itself, because the
  // document is what a person reads to learn the obligation, and a bundle that
  // names its parts only in minified comments meets the licence without meeting
  // the reader.
  {
    const notices = readFileSync(join(ROOT, 'THIRD-PARTY.md'), 'utf8');
    check('the AC-3 coder package is named in THIRD-PARTY.md', notices.includes('@mediabunny/ac3'), true);
    check('the DTS coder package is named in THIRD-PARTY.md', notices.includes('@mediabunny/dts'), true);
    check('the AAC encoder package is named in THIRD-PARTY.md', notices.includes('@mediabunny/aac-encoder'), true);
  }
}

section('attribution is where a person would find it');

{
  // The requirement that made this file exist: CC-CEDICT asks to be told where the
  // data came from. A licence named only inside a 1.2MB data file is not
  // attribution, so the notices file and its content are checked, not assumed.
  // BOTH shipped files, as one haystack. The notice states WHAT is included and under
  // which licence; the notes carry the pins, hashes and rationale. The obligation spans
  // the pair, so the checks read the pair rather than one file, and collapsing runs of
  // whitespace means a phrase is still found where the prose wraps to a newline.
  const noticePath = join(ROOT, 'THIRD-PARTY.md');
  const notesPath = join(ROOT, 'THIRD-PARTY-NOTES.md');
  check('THIRD-PARTY.md exists', existsSync(noticePath), true);
  check('THIRD-PARTY-NOTES.md exists', existsSync(notesPath), true);

  if (existsSync(noticePath) && existsSync(notesPath)) {
    const text = [readFileSync(noticePath, 'utf8'), readFileSync(notesPath, 'utf8')]
      .join('\n')
      .replace(/\s+/g, ' ');
    check('it names CC-CEDICT', /CC-CEDICT/.test(text), true);
    check('it names the licence', /CC BY-SA 4\.0/.test(text), true);
    check('it states the share-alike obligation', /share.?alike/i.test(text), true);
    check('it records the resolved HSK source', /MOE|elkmovie\/hsk30/.test(text), true);
    check('and that Pleco is the OCR tool, not the author', /OCR/i.test(text), true);
    // A4: the notices must carry the pin too, so a reader who never opens the
    // build script can still find the exact revision.
    check('it records the pinned source revision', /a9aea223269eb9820590e5bca783eb299c317439/.test(text), true);
    check('and the content hash', /e49bf4a732790bda359376a10ad59a6d4874be3b0dab66f1add907c0fedf3c10/.test(text), true);
    // The Japanese sources, so a second language cannot ship unattributed.
    check('it names EDRDG, the JMdict origin', /EDRDG/.test(text), true);
    check('it names the JLPT level source', /open-anki-jlpt-decks/.test(text), true);
    check('and pins the Japanese asset hash', /956cb65b95d12d2b81fa550716d53163dbd3c70ca171a9c7dce97d7238c9d87a/.test(text), true);
    // The Korean sources, for the same reason. These are the ones most likely to
    // be missed, because the level data arrives through an MIT aggregator whose
    // licence does NOT cover the data, and the actual grant (KOGL Type 1) is on a
    // separate government page. Naming it here is the whole obligation.
    check('it names the NIKL level source', /National Institute of Korean Language/.test(text), true);
    check('and records the KOGL grant, not the aggregator licence', /KOGL/.test(text), true);
    check('it names the Yonsei definitions source', /Open Yonsei Korean Vocabulary/.test(text), true);
    check('and disclaims Yonsei University affiliation', /not affiliated/i.test(text), true);
    check('it pins the Korean level-list hash', /bb5789e46d818842ed6cc15c7946805ad1aed9fd1d0912d884cc48a8556b9a3c/.test(text), true);
    // TOPIK is deliberately excluded, and the REASON must be recorded rather than
    // the absence left to look like an oversight. If someone revisits this, they
    // need to find why the column is ignored.
    check('it records why TOPIK is excluded', /TOPIK/.test(text), true);
    check('and that the reason is its reserved licence', /corresponding\s+benefit|reserved|requires TOPIK/i.test(text), true);
    // The Pages demo's committed media, the one piece of third-party MEDIA in the
    // repository. It is public domain, so no attribution is legally required, but
    // the source and the recipe are what let a reader verify the bytes. Asserted
    // because a committed film clip with no stated origin is the kind of thing a
    // reviewer has to take on trust, and this project does not ask for trust.
    check('it names the demo film', /Princess Iron Fan/.test(text), true);
    check('it states the public domain grant', /[Pp]ublic domain/.test(text), true);
    check('it gives the archive.org source', /archive\.org\/details\/princess_iron_fan/.test(text), true);
    check('it records that the video is not re-encoded', /stream copy|\-c copy/.test(text), true);
    check('and names the rebuild command', /tools\/pages\/fetch-media\.mjs/.test(text), true);
  }

  // MIT is the one licence here whose condition is to INCLUDE its text, not merely to
  // name it, so the text is asserted present rather than the licence name. This was the
  // gap a review found: `open-anki-jlpt-decks` shipped its JLPT levels with the project
  // named and no permission text anywhere, which meets neither the letter nor the point.
  // CC BY-SA and MPL-2.0 are satisfied by a URI and by the source headers respectively,
  // so only MIT is reproduced, and only MIT is asserted this way.
  {
    const text = readFileSync(join(ROOT, 'THIRD-PARTY.md'), 'utf8');
    check('the MIT permission text is included', /Permission is hereby granted/.test(text), true);
    check('with its warranty disclaimer', /WITHOUT WARRANTY OF ANY KIND/.test(text), true);
    check('and the copyright line it must travel with', /Copyright \(c\) 2020 Jamie Sinclair/.test(text), true);
    check('the MIT component is still named', /open-anki-jlpt-decks/.test(text), true);
  }

  // The notices file existing is not enough: the README is where a reader looks
  // first, and a licence section that names the data obligation is what makes the
  // attribution findable rather than merely present.
  const readme = join(ROOT, 'README.md');
  check('README.md exists', existsSync(readme), true);
  if (existsSync(readme)) {
    const text = readFileSync(readme, 'utf8');
    check('the README points at the third-party notices', /THIRD-PARTY\.md/.test(text), true);
    check('and names the data licence', /CC BY-SA 4\.0/.test(text), true);
  }
}

section('the index names every dictionary, and every dictionary declares its provenance');

{
  // The index must carry NO timestamp. It had a `meta.generatedAt`, and it was the
  // only reason the file could not be reproduced: a build date changes on every
  // run, so `tools/check-wordlists.mjs` could not compare bytes and the drift check
  // it exists for was impossible. Nothing read the field. Asserted as an absence
  // because it is the kind of thing that gets re-added as "useful metadata".
  const indexMeta = JSON.parse(readFileSync(join(ROOT, 'src/learn/data/index.json'), 'utf8')).meta ?? {};
  const stamps = Object.keys(indexMeta).filter((k) => /date|time|generated/i.test(k));
  check('the index carries no build timestamp', stamps, []);

  // With one language the checks below could hardcode chinese.json. With two they
  // have to walk whatever the index declares, or a third language could ship with
  // no licence check at all and nothing would say so.
  const index = JSON.parse(readFileSync(join(ROOT, 'src/learn/data/index.json'), 'utf8'));
  const paths = Object.entries(index.dictionaries ?? {});

  check('the index declares at least one dictionary', paths.length > 0, true);

  const missingFile = paths.filter(([, rel]) => !existsSync(join(ROOT, rel)));
  check('every declared dictionary file exists', missingFile.map(([lang]) => lang), []);

  // Both ends of the same fact: an index entry naming a list, and the dictionary
  // that holds it. A mismatch means one of the two was edited alone.
  //
  // The licence is NO LONGER asserted to be one fixed string. Every dictionary used
  // to be CC BY-SA 4.0 and the check hardcoded it, which was correct until Korean
  // arrived: its definitions are CC BY-SA 3.0 and its level list is KOGL Type 1, so
  // a fixed expectation would have failed a correct payload and invited someone to
  // change the licence in the data to satisfy the test. The set of licences we may
  // ship is enumerated (that is the real guard), and the specific one is derived
  // from the sources rather than asserted.
  const KNOWN_LICENCES = ['CC BY-SA 3.0', 'CC BY-SA 4.0', 'CC BY 4.0', 'KOGL Type 1', 'MIT'];
  // Most to least restrictive. The payload as a whole must satisfy every source it
  // draws on, so the licence it is offered under is the most restrictive of them.
  const RESTRICTIVENESS = ['CC BY-SA 3.0', 'CC BY-SA 4.0', 'CC BY 4.0', 'KOGL Type 1', 'MIT'];

  for (const [language, rel] of paths) {
    const data = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
    const meta = data.meta ?? {};

    check(`[${language}] the data carries a licence`, typeof meta.licence, 'string');
    check(`[${language}] and it is a licence we may ship`, KNOWN_LICENCES.includes(meta.licence), true);
    check(`[${language}] it names the upstream compiler`, String(meta.compiledBy ?? '').length > 0, true);
    check(`[${language}] the word count matches the payload`, meta.wordCount, Object.keys(data.words).length);

    // Every upstream is listed as an object rather than as flat `sourceCommit` /
    // `sourceTag` scalars. Those encoded the number of sources in their NAMES, so
    // they could not describe Korean, whose levels and definitions come from two
    // peers with no "the source" to hang a scalar on.
    const sources = meta.sources;
    check(`[${language}] it lists its sources`, Array.isArray(sources) && sources.length > 0, true);
    const unnamed = (sources ?? []).filter((s) => !String(s.name ?? '').length);
    check(`[${language}] every source is named`, unnamed.length, 0);
    const unlicensed = (sources ?? []).filter((s) => !KNOWN_LICENCES.includes(s.licence));
    check(`[${language}] every source declares a licence we may ship`, unlicensed.map((s) => s.name), []);

    // The offered licence is DERIVED, and this is the check that it was derived
    // consistently: it must equal the most restrictive of the sources listed. A
    // hand-set string that drifts from the list above it fails here.
    const mostRestrictive = RESTRICTIVENESS.find((l) => (sources ?? []).some((s) => s.licence === l));
    check(`[${language}] the offered licence is the most restrictive of its sources`, meta.licence, mostRestrictive);

    // Finding A4. The input is not committed, so reproducibility depends on the
    // artefact naming the exact revision it was built from. A commit alone can be
    // rewritten; the content hash cannot. At least ONE source must pin a content
    // hash or a commit, or the payload cannot be rebuilt, and any pin that IS
    // present must be well formed rather than a placeholder that merely has the
    // right length.
    const pins = (sources ?? []).filter((s) => s.sha256 || s.commit);
    check(`[${language}] at least one source is pinned to a revision`, pins.length > 0, true);
    const badHash = (sources ?? []).filter((s) => s.sha256 && !/^[0-9a-f]{64}$/.test(String(s.sha256)));
    check(`[${language}] every content hash is a real sha256`, badHash.map((s) => s.name), []);
    const badCommit = (sources ?? []).filter((s) => s.commit && !/^[0-9a-f]{40}$/.test(String(s.commit)));
    check(`[${language}] every commit is a full revision`, badCommit.map((s) => s.name), []);

    // Every list the dictionary offers must be a list the index promises, and
    // vice versa, otherwise a list could exist in one place and not the other.
    const inDict = new Set((data.lists ?? []).map((l) => l.id));
    const inIndex = new Set((index.lists ?? []).filter((l) => l.dictionary === language).map((l) => l.id));
    check(
      `[${language}] the dictionary and the index offer the same lists`,
      [...inDict].sort().join(','),
      [...inIndex].sort().join(','),
    );
  }

  // A list in the index must name a dictionary the index defines, or the worker
  // cannot resolve a path for it.
  const dangling = (index.lists ?? []).filter((l) => !index.dictionaries?.[l.dictionary]);
  check('no list names an undefined dictionary', dangling.map((l) => l.id), []);
}

section('every dictionary carries the fields the app reads from a list');

{
  // Reproducibility has a second half that a hash check cannot see. Pinning the
  // input only helps if the BUILD is faithful: a field hand-added to the JSON and
  // never taught to `tools/build-wordlist.mjs` disappears the moment anyone
  // rebuilds, which is exactly what happened to `defaultThreshold`, silently
  // moving the starting level.
  //
  // So every field the code reads off a list is asserted to be present here,
  // for every dictionary rather than only the Chinese one.
  const index = JSON.parse(readFileSync(join(ROOT, 'src/learn/data/index.json'), 'utf8'));
  const REQUIRED = ['id', 'label', 'language', 'levelCount', 'levelled', 'levelNames'];

  for (const [language, rel] of Object.entries(index.dictionaries ?? {})) {
    const data = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
    const lists = data.lists ?? [];

    const missing = [];
    for (const list of lists) {
      for (const field of REQUIRED) {
        if (!(field in list)) missing.push(`${list.id ?? '?'}.${field}`);
      }
    }
    check(`[${language}] every list has every required field`, missing, []);

    // The starting level is NOT data. It is the learner's own choice, remembered
    // per list by the app, defaulting to the first level.
    //
    // It used to travel with the list, and it was `4` for both HSK lists, the
    // personal level of whoever built this, shipped as a constant to everybody.
    // The midpoint of the range replaced it and was no better: still the app
    // deciding how good a stranger is at a language it has never seen them read.
    //
    // Asserting the ABSENCE is the point. A field here would be a starting level
    // chosen by whoever wrote the data, which is exactly the bug.
    const stray = lists.filter((l) => 'defaultThreshold' in l);
    check(`[${language}] no list carries a starting level`, stray.map((l) => l.id), []);

    // Every list names its own levels, ascending in difficulty. JLPT runs N5->N1
    // while HSK runs 1->N, so the label cannot be derived from the level number,
    // printing the number rendered JLPT's easiest level (internal 1) as "JLPT 1",
    // which a human reads as N1, the hardest.
    const wrongNames = lists.filter((l) => (l.levelNames ?? []).length !== l.levelCount);
    check(`[${language}] every list names exactly as many levels as it declares`, wrongNames.map((l) => l.id), []);

    // Difficulty must ascend, or the threshold's "at or above" test marks the
    // wrong end of the list. Checked on the label where the list carries one.
    const unordered = [];
    for (const list of lists) {
      if (list.id !== 'jlpt') continue;
      if (String(list.levelNames?.[0]) !== 'N5' || String(list.levelNames?.at(-1)) !== 'N1') {
        unordered.push(list.id);
      }
    }
    check(`[${language}] a list whose naming is reversed is declared in that order`, unordered, []);
  }
}

section('no committed fixture contains a real video title');

{
  // Found by audit: `player-response.json` held the real video's title while its
  // sibling `video.json` said "Synthetic". A corpus whose files disagree about
  // being synthetic is worse than either answer, and the real title is someone
  // else's words in a committed file.
  const dir = join(ROOT, 'test', 'synthetic');
  const sets = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];

  const offenders = [];
  for (const set of sets) {
    for (const file of ['video.json', 'player-response.json']) {
      const path = join(dir, set.name, file);
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const title = parsed.title ?? parsed.videoDetails?.title;
      if (title && !/synthetic/i.test(title)) offenders.push(`${set.name}/${file}: ${title}`);
    }
  }

  check(`all ${sets.length} fixture set(s) carry a synthetic title`, offenders, []);
}

section('every dictionary source is named on the licences screens');

{
  // The UI renders `SOURCES` from `src/common/sources.js`, one row per third-party
  // work, on the panel's licences view and in the viewer's shortcut panel. This is the
  // check that keeps that list honest against the DATA: every `meta.sources[]` entry in
  // every dictionary must be named here, so a fourth dictionary cannot ship with words
  // on screen that no screen attributes.
  //
  // The DIRECTION matters and is deliberate. The data is the source of truth and the UI
  // list is its projection, so a source in the data with no row is a FAILURE (an
  // unattributed work), while a row for a work no longer used is not: removing a
  // dictionary is a build change, and a stale row is caught by a person reading the
  // page rather than by a test inventing a rule. The `name` is compared in full, not by
  // prefix, because that is what the two files already agree on.
  const { SOURCES } = await import('../src/common/sources.js');
  const named = new Set(SOURCES.map((s) => s.name));
  const licenceOf = new Map(SOURCES.map((s) => [s.name, s.licence]));

  const index = JSON.parse(readFileSync(join(ROOT, 'src/learn/data/index.json'), 'utf8'));

  const unnamed = [];
  const mismatched = [];
  for (const [, rel] of Object.entries(index.dictionaries ?? {})) {
    const data = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
    for (const source of data.meta?.sources ?? []) {
      if (!named.has(source.name)) {
        unnamed.push(source.name);
        continue;
      }
      // The licence string is compared too: a row that names a work under the wrong
      // licence is a false statement to a reader, which is worse than no row, because
      // it looks like compliance.
      if (licenceOf.get(source.name) !== source.licence) {
        mismatched.push(`${source.name}: page says ${licenceOf.get(source.name)}, data says ${source.licence}`);
      }
    }
  }

  check('every dictionary source is named in SOURCES', unnamed, []);
  check('and every one states the licence the data declares', mismatched, []);

  // A row with no name or no licence would render as a blank line under a heading
  // that claims to be an acknowledgement, so the list is checked in its own right too.
  const incomplete = SOURCES.filter((s) => !s.name || !s.licence || !s.changes);
  check('every SOURCES row names a work, a licence and its change', incomplete.map((s) => s.name ?? '(unnamed)'), []);
  check('and the list is not empty', SOURCES.length > 0, true);

  // Both screens offer a button that opens `THIRD-PARTY.md` from the extension's own
  // package, so the exact filename is part of the UI contract. The button is useless if
  // the file is renamed or stops shipping, and nothing else would notice: the file
  // existing in the repo is not the same as it being in the installed extension.
  const notice = join(ROOT, 'THIRD-PARTY.md');
  check('the notice the buttons open exists', existsSync(notice), true);
  check('and it is not empty', existsSync(notice) && readFileSync(notice, 'utf8').trim().length > 100, true);

  // Read from the Makefile rather than restated, so the two cannot disagree: this is
  // the same list `tools/verify-zip.mjs` uses to decide what a built package contains.
  const makefile = readFileSync(join(ROOT, 'Makefile'), 'utf8');
  const shippedLine = /^SHIPPED := ([\s\S]*?)(?=\n\n)/m.exec(makefile)?.[1] ?? '';
  const shipped = shippedLine.replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
  check('and it is in the Makefile SHIPPED list', shipped.includes('THIRD-PARTY.md'), true);

  // The licences PAGE, which the viewer's `A` key and the panel's button both open. It
  // is STATIC markup, so nothing at runtime keeps it in step with `SOURCES`, and it is
  // the surface a learner actually reads. Each source's display name and licence must
  // appear, or the page a reader is sent to is missing a work the app displays.
  const pagePath = join(ROOT, 'src', 'licences', 'licences.html');
  check('the licences page exists', existsSync(pagePath), true);

  if (existsSync(pagePath)) {
    const page = readFileSync(pagePath, 'utf8');
    // Whitespace collapsed, because a long source name wraps in the markup and a
    // literal substring match would miss it.
    const flat = page.replace(/\s+/g, ' ');

    const absentNames = SOURCES.filter((s) => !flat.includes(s.name));
    check('every source name is on the page', absentNames.map((s) => s.name), []);

    const absentLicences = SOURCES.filter((s) => !flat.includes(s.licence));
    check('and every source licence is on the page', absentLicences.map((s) => s.licence), []);

    // No script: the page holds no state, so a script is only a way for it to render
    // empty when a module fails to load. Asserted as an absence so it is not added
    // "for consistency" later.
    check('the page has no script', /<script/i.test(page), false);

    // No web host. This is an HTML file, not a `.js` one, so `test/manifest.test.mjs`'s
    // hostname scan does not cover it, and this is the check that keeps it from quietly
    // becoming a surface that links out to the network.
    const hosts = [...page.matchAll(/https?:\/\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
    check('and it links to no external host', hosts, []);
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
