/**
 * Checks the STAGED diff for things that should not be committed.
 *
 *   node tools/check-staged.mjs
 *
 * Run by `.githooks/pre-commit`, and runnable by hand. Exits non-zero with a list
 * of problems, so a commit that trips one is refused rather than landing and being
 * cleaned up later.
 *
 * ## Why these checks and not a linter
 *
 * The repository has no linter, deliberately: it has no build step and no runtime
 * dependencies, and adding ESLint to a project that ships plain ES modules costs a
 * dependency tree and a config file to catch things the 15 test suites already
 * catch. What the tests CANNOT catch is anything about the commit itself, what is
 * being staged and how, and that is what this covers. Each check here is one this
 * project has actually been bitten by or has a standing rule about:
 *
 *   - **Em dashes.** A standing, forceful rule ("no em dashes, ever, anywhere").
 *     Nothing else enforces it, so a stray one reaches a commit silently.
 *   - **Merge conflict markers.** A conflict resolved by `git add` without reading
 *     the file commits the markers, and the tests fail later with a confusing
 *     message far from the cause.
 *   - **Huge files.** `build/` is gitignored but `tools/pages/media/` was not, and
 *     a 31 MB video nearly went in. Git history cannot be shrunk afterwards without
 *     a rewrite.
 *   - **`debugger` and a focused test.** Both are "temporary" and both have shipped
 *     from other projects; a test with `.only` silently disables the rest of its
 *     suite, which reads as passing.
 *   - **Trailing whitespace.** The repository strips it (a sweep removed 80 lines'
 *     worth), so adding it is a regression against the existing state.
 *
 * ## Speed
 *
 * Only the staged diff is read, so this is milliseconds and can run on every
 * commit. The test suite is NOT run here: it is a second, and CI already runs it
 * on the pushed commit. A hook slow enough to be bypassed is worse than no hook.
 *
 * ## Bypassing
 *
 * `git commit --no-verify`, for the case where the check is genuinely wrong. Not
 * documented in the README, because the point is that it is the exception.
 */

import { execFileSync } from 'node:child_process';

/**
 * The em dash CHECKED for, written as an escape so this file does not itself
 * contain one. The ban is on the character, and a literal here would be the first
 * violation of the rule it enforces, which is exactly what the hook reported the
 * first time it ran against this file.
 */
const EM_DASH = '\u2014';

/**
 * Files allowed to contain an em dash, with the reason.
 *
 * An allowlist rather than a blanket rule because the check is on ADDED lines and
 * these are data files, not prose: editing them re-emits their existing characters,
 * which would look like a new violation on every rebuild.
 */
const DASH_EXEMPT = new Set([
  // CC-CEDICT derivative; contains em dashes in glosses upstream. Not ours to edit.
  'src/learn/data/chinese.json',
]);

/** Merge markers, matched at the start of a line where git writes them. */
const CONFLICT = /^(<{7}|={7}|>{7})( |$)/;

/**
 * Files exempt from the trailing-whitespace check, with the reason.
 *
 * Generated code is not ours to tidy. `src/vendor/mediabunny.js` is produced by
 * `node tools/build-vendor.mjs` from the MPL-2.0 packages, and its minified output
 * carries trailing whitespace we neither wrote nor may edit; flagging it would mean
 * either stripping lines from a generated file (which the next rebuild undoes) or
 * bypassing the hook on every rebuild commit. Exempted by exact name, like the other
 * allowlists here, so nothing else is covered by accident. A hand-written file with
 * trailing whitespace is still caught.
 */
const WHITESPACE_EXEMPT = new Set(['src/vendor/mediabunny.js']);

/**
 * Above this, a staged file is probably not meant for the repository.
 *
 * 8 MB, chosen against the largest legitimate file: `src/learn/data/japanese.json`
 * at 2.8 MB. A dictionary is expected to be large; a video, a build artifact or a
 * stray archive is not, and those are what this is looking for. Set with headroom
 * so a growing dictionary does not trip it by accident.
 *
 * The demo clip is over it and is exempted by name below, because the exception is
 * a decision somebody made rather than a number this check should have chosen
 * differently.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Files allowed to exceed `MAX_BYTES`, with the reason.
 *
 * An allowlist rather than a higher limit: raising the limit would let the next
 * 30 MB accidental artifact through, and the whole point is that this size is the
 * exception. Each entry is a deliberate, stated decision.
 */
const SIZE_EXEMPT = new Map([
  [
    'tools/pages/media/demo.mp4',
    'the GitHub Pages demo clip, public domain, committed so a deploy does not ' +
      'depend on archive.org. See THIRD-PARTY.md.',
  ],
]);

/** @returns {string[]} NUL-separated paths are avoided by using the line form. */
function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

/**
 * The added lines of the staged diff, grouped by file.
 *
 * `-U0` so no context lines are included: a context line is NOT being added by this
 * commit, and checking it flags pre-existing content the author did not touch.
 * Parsed by hand rather than with `--numstat` because the checks need the line TEXT
 * and the line NUMBER, and `+++` in the diff marks the file a run of `+` lines
 * belongs to.
 *
 * @returns {Map<string, Array<{ line: number, text: string }>>}
 */
function addedLines() {
  const diff = execFileSync(
    'git',
    ['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACM'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  /** @type {Map<string, Array<{ line: number, text: string }>>} */
  const byFile = new Map();
  let file = null;
  let lineNo = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      // `+++ b/path`, or `+++ /dev/null` for a deletion (excluded by the filter).
      const path = raw.slice(4).trim();
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      if (file && !byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (raw.startsWith('@@')) {
      // `@@ -a,b +c,d @@`, take `c` as the starting line of the new side.
      const match = /\+(\d+)/.exec(raw);
      lineNo = match ? Number(match[1]) : 0;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      byFile.get(file)?.push({ line: lineNo, text: raw.slice(1) });
      lineNo++;
    } else if (raw.startsWith(' ')) {
      lineNo++;
    }
    // `-` lines and `\ No newline` do not advance the NEW-side counter.
  }

  return byFile;
}

/** @param {string} path @returns {boolean} */
function isBinary(path) {
  try {
    const out = execFileSync('git', ['check-attr', 'binary', '--', path], { encoding: 'utf8' });
    return out.includes('binary: set');
  } catch {
    return false;
  }
}

/** @param {string} path @returns {number} */
function stagedSize(path) {
  // The size of the STAGED blob, not the working tree: a file can be edited after
  // `git add`, and it is what is staged that will be committed.
  const out = execFileSync('git', ['cat-file', '-s', `:${path}`], { encoding: 'utf8' });
  return Number(out.trim());
}

function main() {
  /** @type {string[]} */
  const problems = [];
  const files = stagedFiles();

  if (!files.length) {
    console.log('check-staged: nothing staged');
    return 0;
  }

  const added = addedLines();

  for (const path of files) {
    if (isBinary(path)) continue;

    const lines = added.get(path) ?? [];

    if (!DASH_EXEMPT.has(path)) {
      for (const { line, text } of lines) {
        if (text.includes(EM_DASH)) {
          problems.push(
            `${path}:${line}  em dash (U+2014). Use a comma, colon, semicolon, parentheses, or a full stop.`,
          );
        }
      }
    }

    for (const { line, text } of lines) {
      if (CONFLICT.test(text)) {
        problems.push(`${path}:${line}  merge conflict marker: ${text.slice(0, 40)}`);
      }
      if (/^\s*debugger\s*;?\s*$/.test(text)) {
        problems.push(`${path}:${line}  leftover \`debugger\` statement`);
      }
    }

    for (const { line, text } of lines) {
      // Only on a line with content, so a genuinely blank line is not flagged.
      if (!WHITESPACE_EXEMPT.has(path) && text.trim() && text !== text.replace(/\s+$/, '')) {
        problems.push(`${path}:${line}  trailing whitespace`);
      }
    }

    // `.only` in a test file silently disables the rest of its suite, which reads
    // as passing. Checked only under `test/`, where the pattern is a mistake; a
    // source file may legitimately mention `.only`.
    if (path.startsWith('test/')) {
      for (const { line, text } of lines) {
        if (/\b(it|test|describe|check|section)\.only\s*\(/.test(text)) {
          problems.push(`${path}:${line}  focused test (.only), which disables the rest of the suite`);
        }
      }
    }

    const size = stagedSize(path);
    if (size > MAX_BYTES && !SIZE_EXEMPT.has(path)) {
      problems.push(
        `${path}  ${(size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_BYTES / 1024 / 1024} MB limit. Git history cannot be shrunk later.`,
      );
    }
  }

  if (problems.length) {
    console.error(`\ncheck-staged: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('\nFix them, or `git commit --no-verify` if the check is wrong.\n');
    return 1;
  }

  console.log(`check-staged: ok (${files.length} file${files.length === 1 ? '' : 's'})`);
  return 0;
}

process.exit(main());
