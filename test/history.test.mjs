/**
 * Scrub guards.
 *
 * The repository's history was rewritten once to remove identifiers that had
 * leaked from a real capture: the video's title, its id, and — never committed,
 * but checked for completeness — the uploader's own description. That work is
 * invisible once done, which is exactly why it needs a guard: nothing about a
 * normal `git commit` would ever tell you the leak had returned.
 *
 * Three things are checked, because an identifier can hide in three places and
 * fixing one does not fix the others:
 *
 *   1. the content of tracked files right now;
 *   2. the content of every blob in every commit (a string can live on in old
 *      history after being removed from HEAD — that is what a rewrite is for);
 *   3. every path ever used (a filename can carry an id even when no file
 *      content does).
 *
 * The needles are the real values, base64-encoded so that this file does not
 * itself contain the strings it forbids — otherwise `git grep` would match the
 * guard and it would fail on itself. This is the one test allowed to name what it
 * forbids, because a guard that does not is not a guard.
 *
 * Skipped, not failed, when there is no git repository — an exported tarball is a
 * legitimate way to hold this code.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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
 * Run git, returning stdout, or null when git is unavailable or this is not a
 * repository. Never throws: a missing history is an environment fact, not a
 * finding.
 *
 * @param {string[]} args
 * @returns {string|null}
 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/**
 * Strings that must not appear anywhere, base64-encoded. The real video's id and
 * title, and the uploader's handle from its description — the last is
 * belt-and-braces: it lives only in the gitignored capture, so this also catches
 * anyone un-ignoring that.
 *
 * The title needle is the distinctive half of the title — the part naming the
 * specific trip — not the whole string, and not the generic theme word that
 * legitimately appears as a mojibake example in `capture.mjs`. That theme word is
 * not identifying, and a guard that fires on it gets deleted, taking the real
 * protection with it.
 *
 * Encode a needle with:
 *   node -e "console.log(Buffer.from(process.argv[1],'utf8').toString('base64'))" '<text>'
 */
const FORBIDDEN = [
  { what: 'the real video id', b64: 'OGI0Tlk1cUhTMlU=' },
  { what: 'the real video title', b64: '5ZCD5Yiw5YGc5LiN5LiL5p2l55qE5rex5Zyz5LmL5peF' },
  { what: 'the uploader handle', b64: 'aG9sYWlzYnVzeQ==' },
].map(({ what, b64 }) => ({ what, value: Buffer.from(b64, 'base64').toString('utf8') }));

const isRepo = git(['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';

if (!isRepo) {
  console.log('\n(no git repository — history checks skipped)');
} else {
  section('no leaked identifier appears in any tracked file');

  for (const { what, value } of FORBIDDEN) {
    // `git grep` searches tracked files only, which is exactly the scope: the
    // gitignored capture is allowed to hold these, the repository is not.
    const hits = git(['grep', '-l', '-I', '--', value]) ?? '';
    const files = hits.split('\n').filter(Boolean);
    check(`${what} is absent from tracked files`, files, []);
  }

  section('no leaked identifier appears in any commit');

  for (const { what, value } of FORBIDDEN) {
    // -S is the pickaxe: it reports commits that changed the number of
    // occurrences of the string, which is how a value removed from HEAD but still
    // present in an older blob is caught.
    const hits = git(['log', '--all', '--oneline', '-S', value]) ?? '';
    const commits = hits.split('\n').filter(Boolean);
    check(`${what} is absent from all history`, commits, []);
  }

  section('no leaked identifier appears in any path ever used');

  for (const { what, value } of FORBIDDEN) {
    // Object list is "<sha> <path>"; grep the whole line, so an id in a directory
    // name is caught as surely as one in a file name.
    const listing = git(['rev-list', '--objects', '--all']) ?? '';
    const paths = listing.split('\n').filter((line) => line.includes(value));
    check(`${what} is absent from every historical path`, paths, []);
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
