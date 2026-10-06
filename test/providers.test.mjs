/**
 * Video provider checks.
 *
 * The seam exists so that no file outside `providers.js` has to name a video
 * site. That is easy to state and easy to erode, so two things are asserted:
 *
 *   1. `providerFor` answers correctly — the interesting case is a URL that
 *      must NOT match, since a provider that matches everything would silently
 *      try to read captions from every tab.
 *   2. No module outside the provider's own files mentions a site name. This is
 *      the check that keeps the seam real: the day someone writes
 *      `if (url.includes('youtube'))` in the worker again, this fails.
 *
 * Run with `npm test`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerFor, providerNames, listProviderIds } from '../src/common/providers.js';

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

section('the registry answers for URLs, and refuses what it cannot read');

{
  check('a known provider is registered', listProviderIds().length >= 1, true);
  check('youtube is among them', listProviderIds().includes('youtube'), true);

  // Positive: every shape of youtube document the content script can read.
  for (const url of [
    'https://www.youtube.com/watch?v=abc123',
    'https://youtube.com/shorts/abc123',
    'https://m.youtube.com/watch?v=abc123',
    'https://www.youtube.com/embed/abc123',
  ]) {
    check(`matches ${url}`, providerFor(url)?.id, 'youtube');
  }

  // Negative: the important half. A provider must not claim a tab it cannot
  // read, or the worker injects into it and the panel reports captions that will
  // never arrive.
  for (const url of [
    'https://www.google.com/',
    'https://example.com/watch?v=abc123',
    // A lookalike host must not match: the pattern anchors on the domain.
    'https://notyoutube.com/watch?v=abc123',
    'https://youtube.com.evil.example/watch',
    null,
    undefined,
    '',
  ]) {
    check(`refuses ${JSON.stringify(url)}`, providerFor(url), null);
  }
}

section('the provider names read correctly for user-facing text');

{
  // With one provider registered the sentence must be exactly what it was
  // before the seam existed, or the panel's wording changes for no reason.
  check('one provider reads as its plain name', providerNames(), 'YouTube');
}

section('no module outside the provider names a video site');

{
  // The provider's own content scripts are site-specific by definition — they
  // read one site's player internals — so they are exempt. Everything else is
  // the code the seam exists to keep generic.
  const EXEMPT = [
    'src/common/providers.js',
    'src/content/youtube-content.js',
    'src/content/page-bridge.js',
    'src/learn/data/', // the dictionary, where a word may be the word "youtube"
  ];

  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith('.js')) out.push(full);
    }
    return out;
  };

  const offenders = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = file.slice(ROOT.length + 1);
    if (EXEMPT.some((prefix) => rel === prefix || rel.startsWith(prefix))) continue;

    // Strip comments: prose is allowed to say "YouTube" (it is the clearest way
    // to explain something); a CODE reference is what couples the module.
    const source = readFileSync(file, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/youtube/i.test(code)) offenders.push(rel);
  }

  check('no site name appears in code outside the provider', offenders, []);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
