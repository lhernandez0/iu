/**
 * Error-code checks.
 *
 * The registry in `src/common/errors.js` is canonical, and the content script
 * carries a copy because a classic script cannot `import`. That duplication is
 * safe only while the two agree, and the failure it permits is quiet: a code
 * raised by the content script that the registry does not define would be
 * reported as `CONN999 Unknown error`, specific-looking and meaningless.
 *
 * So this suite does three things:
 *
 *   1. Every code is well-formed and unique, and its message is non-empty.
 *   2. Every code the CONTENT SCRIPT can raise exists in the registry, with the
 *      same message. Read from the source, because the script cannot be imported.
 *   3. No error string in the extension is still a bare sentence where a code
 *      belongs. That is the check with the longest reach: it is what stops a
 *      future error being added the old way.
 *
 * Run with `npm test`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERRORS, errorText, codeError, errorCodes, CODE_PATTERN } from '../src/common/errors.js';

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

section('every code is well formed, unique and explained');

{
  const codes = errorCodes();
  check('the registry is not empty', codes.length > 0, true);

  const malformed = codes.filter((code) => !CODE_PATTERN.test(code));
  check('every code is three letters and three digits', malformed, []);

  // Uniqueness is a property of an object's keys by construction, so this asserts
  // something stronger: that no two codes share a MESSAGE. Two codes with one
  // sentence are two names for one fault, which makes a report ambiguous again.
  const messages = Object.values(ERRORS).map((d) => d.message);
  const duplicates = messages.filter((m, i) => messages.indexOf(m) !== i);
  check('no two codes share a message', duplicates, []);

  const empty = Object.entries(ERRORS).filter(([, d]) => !d?.message).map(([code]) => code);
  check('every code has a message', empty, []);

  // The category is a documented slug, and a new one is a deliberate act rather
  // than a typo that quietly creates a `CONM001`. Extracted as everything before
  // the three digits, so a 4-letter slug like CONN is read correctly.
  //
  // VIEWER is the local video page, a source we host rather than a site we read,
  // which is why its faults get their own slug: they are about the user's files,
  // where the honest answer names the file type rather than suggesting a retry.
  const known = new Set(['CONN', 'VIDEO', 'TRACK', 'DICT', 'PAGE', 'VIEWER']);
  const unknown = codes.filter((code) => !known.has(code.replace(/\d{3}$/, '')));
  check('every code uses a documented category', unknown, []);
}

section('errorText renders the code first, and only appends a detail when allowed');

{
  const full = errorText('CONN002', 'provide did not answer within 4000ms');
  check('a detail-bearing code includes the detail', full, 'CONN002 The page did not answer in time. (provide did not answer within 4000ms)');
  check('and it starts with the code', full.startsWith('CONN002 '), true);

  // A code whose sentence is complete must not take a detail, or the same code
  // renders differently run to run and stops being greppable.
  check('a self-contained code ignores a detail', errorText('VIDEO001', 'whatever'), 'VIDEO001 This video has no captions.');

  check('a missing detail is fine', errorText('CONN003'), 'CONN003 Could not reach the page.');
  // A code that is not in the registry must say so rather than rendering as an
  // unexplained sentence, a report has to be able to say "this code is unknown".
  check('an unknown code names itself', errorText('ZZZ999').startsWith('ZZZ999 Unknown error'), true);
}

section('codeError does not re-code an already-coded failure');

{
  // The propagation rule: the innermost layer knows best, so an outer layer must
  // pass a coded message through. Wrapping it again is how one fault becomes a
  // message with two codes and no clear cause.
  check('a coded error passes through unchanged', codeError('TRACK003', new Error('CONN002 The page did not answer in time. (provide)')), 'CONN002 The page did not answer in time. (provide)');
  check('an uncoded error gets the fallback code', codeError('TRACK003', new Error('boom')), 'TRACK003 Could not load captions. (boom)');
  check('a message that merely mentions a code mid-sentence is still wrapped', codeError('TRACK003', new Error('saw CONN002 once')), 'TRACK003 Could not load captions. (saw CONN002 once)');
  check('a non-Error value is handled', codeError('CONN003', 'plain string'), 'CONN003 Could not reach the page. (plain string)');
}

section('the content script\'s copy of the codes matches the registry');

{
  // The content script cannot be imported, so its table is read as source.
  const source = readFileSync(join(ROOT, 'src/content/youtube-content.js'), 'utf8');
  const block = /const ERR = \{([\s\S]*?)\n  \};/.exec(source);
  check('the content script has an ERR table', Boolean(block), true);

  if (block) {
    // Each line is `<CODE>: '<message>',`. The message is captured greedily to
    // the last quote on the line, so an apostrophe inside it (as in "video’s")
    // does not truncate the match.
    const entries = [...block[1].matchAll(/^\s*([A-Z]{2,6}\d{3}):\s*'(.*)',\s*$/gm)].map((m) => [m[1], m[2]]);
    check('it defines some codes', entries.length > 0, true);

    const unknown = entries.filter(([code]) => !ERRORS[code]).map(([code]) => code);
    check('every code it defines exists in the registry', unknown, []);

    // The messages must agree too, or the same code reads differently depending
    // on which layer produced it, which defeats the point of a code.
    const mismatched = entries
      .filter(([code, message]) => ERRORS[code] && ERRORS[code].message !== message)
      .map(([code]) => code);
    check('and every message matches the registry', mismatched, []);

    // THE CHECK THAT MATTERS, and the one that was missing: every code the script
    // RAISES must be one it also DEFINES. Defining a code and never using it is
    // harmless; using one that is not defined renders as `XXXXXX Unknown error`,
    // which looks specific and means nothing, and it is silent, because the
    // fallback is a valid string. Found a real instance of exactly this: VIDEO001
    // was raised by the fallback track path and was not in the table.
    const defined = new Set(entries.map(([code]) => code));
    const raisedCodes = [...source.matchAll(/\berr\('([A-Z]{2,6}\d{3})'/g)].map((m) => m[1]);
    const undefinedRaised = [...new Set(raisedCodes)].filter((code) => !defined.has(code));
    check('every code it raises is one it defines', undefinedRaised, []);
  }
}

section('no extension source raises an uncoded error string');

{
  // The reach that matters. A new error added the old way, a bare sentence,
  // would show up as an unexplained message with no code, which is exactly the
  // situation this work exists to end.
  const FILES = [
    'src/background/service-worker.js',
    'src/content/youtube-content.js',
    'src/content/page-bridge.js',
    'src/sidepanel/sidepanel.js',
  ];

  const offenders = [];
  for (const rel of FILES) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // `error: '<sentence>'` and `error = '<sentence>'` where the sentence looks
    // like prose rather than a code. A code is 5-9 characters; a message that
    // begins with one is coded, anything else is uncoded.
    const isCoded = (text) => /^[A-Z]{2,6}\d{3}(?:\s|$)/.test(text);
    for (const match of code.matchAll(/\berror\s*[:=]\s*'([^']{12,})'/g)) {
      if (!isCoded(match[1])) offenders.push(`${rel}: ${match[1].slice(0, 40)}`);
    }
    // Template literals assigned to an error field, which are how the dynamic
    // messages used to be built.
    for (const match of code.matchAll(/\berror\s*[:=]\s*`([^`]{12,})`/g)) {
      if (!isCoded(match[1])) offenders.push(`${rel}: \`${match[1].slice(0, 40)}…\``);
    }
  }

  check('every error field starts with a code', offenders, []);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
