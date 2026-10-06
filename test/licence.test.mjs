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
 * human maintained, and says so when something is not on it — a check that guesses
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
 * dependency of its own — and so it sees the transitive packages, which is where a
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
    console.log('  (no node_modules — nothing to check)');
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
  // The claim worth protecting: the shipped extension is our code and nothing
  // else. If someone imports a library into src/, that stops being true and the
  // licence obligations change with it.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  check('there are no runtime dependencies', pkg.dependencies ?? {}, {});
  // No `web_accessible_resources` means no bundled third-party asset is served.
  check('the manifest exposes no resources', manifest.web_accessible_resources ?? undefined, undefined);
  check('the extension declares no content security policy it cannot honour', typeof manifest.content_security_policy, 'undefined');
}

section('attribution is where a person would find it');

{
  // The requirement that made this file exist: CC-CEDICT asks to be told where the
  // data came from. A licence named only inside a 1.2MB data file is not
  // attribution, so the notices file and its content are checked, not assumed.
  const notices = join(ROOT, 'THIRD-PARTY.md');
  check('THIRD-PARTY.md exists', existsSync(notices), true);

  if (existsSync(notices)) {
    const text = readFileSync(notices, 'utf8');
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
  for (const [language, rel] of paths) {
    const data = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
    const meta = data.meta ?? {};

    check(`[${language}] the data carries a licence`, typeof meta.licence, 'string');
    check(`[${language}] and it is the share-alike one`, meta.licence, 'CC BY-SA 4.0');
    check(`[${language}] it names a source`, String(meta.source ?? '').length > 0, true);
    check(`[${language}] it names the upstream compiler`, String(meta.compiledBy ?? '').length > 0, true);
    check(`[${language}] the word count matches the payload`, meta.wordCount, Object.keys(data.words).length);

    // Finding A4. The input is not committed, so reproducibility depends on the
    // artefact naming the exact revision it was built from. A commit alone can be
    // rewritten; the content hash cannot, so a hash is required — and for the
    // Chinese source, whose upstream is a git repo, a commit as well.
    check(`[${language}] it pins a source content hash`, /^[0-9a-f]{64}$/.test(String(meta.sourceSha256)), true);
    if (language === 'zh') {
      check(`[${language}] it pins the source commit`, /^[0-9a-f]{40}$/.test(String(meta.sourceCommit)), true);
    }

    // Every list the dictionary offers must be a list the index promises, and
    // vice versa — otherwise a list could exist in one place and not the other.
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
  // rebuilds — which is exactly what happened to `defaultThreshold`, silently
  // moving the starting level.
  //
  // So every field the code reads off a list is asserted to be present here,
  // for every dictionary rather than only the Chinese one.
  const index = JSON.parse(readFileSync(join(ROOT, 'src/learn/data/index.json'), 'utf8'));
  const REQUIRED = ['id', 'label', 'language', 'levelCount', 'levelled', 'defaultThreshold'];

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

    // `defaultThreshold` in particular: the worker reads it and falls back to 1,
    // so its absence is not an error, only a silent behaviour change. Bounds-check
    // it against its own list instead of trusting the value.
    const bad = lists.filter(
      (l) => !Number.isFinite(l.defaultThreshold) || l.defaultThreshold < 1 || l.defaultThreshold > l.levelCount,
    );
    check(`[${language}] every default threshold is a level that exists in its list`, bad.map((l) => l.id), []);
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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
