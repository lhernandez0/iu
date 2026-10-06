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

section('the bundled dictionary declares its own provenance');

{
  // Both ends of the same fact: the artefact says what it is, and it agrees with
  // the notices file. A mismatch would mean one of the two was edited alone.
  const data = JSON.parse(readFileSync(join(ROOT, 'src/learn/data/chinese.json'), 'utf8'));
  const meta = data.meta ?? {};

  check('the data carries a licence', typeof meta.licence, 'string');
  check('and it is the share-alike one', meta.licence, 'CC BY-SA 4.0');
  check('it names its source', /CC-CEDICT/.test(String(meta.source)), true);
  check('with a word count that matches the payload', meta.wordCount, Object.keys(data.words).length);
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
