/**
 * Tests for the local diagnostics ring.
 *
 * These are the facts a support file depends on: retention, size, ordering,
 * corruption recovery, and that a caller cannot smuggle page content into a
 * record by naming a field the log does not accept.
 */

import { createDiagnostics, normaliseLog, prune, toJsonl, MAX_ENTRIES } from '../src/common/diagnostics.js';

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

function fakeApi(initial = {}) {
  const bucket = { ...initial };
  return {
    bucket,
    api: {
      storage: {
        local: {
          get: async (key) => ({ [key]: bucket[key] }),
          set: async (value) => Object.assign(bucket, value),
          remove: async (key) => delete bucket[key],
        },
      },
    },
  };
}

const nowAt = (ms) => () => ms;

section('append, sanitise and order');

{
  let now = Date.UTC(2026, 0, 1);
  const { api, bucket } = fakeApi();
  const log = createDiagnostics(api, { version: '0.1.0', target: 'chrome', now: () => now });

  await log.append({
    level: 'info',
    scope: 'viewer',
    event: 'viewer.file',
    detail: {
      ext: 'mkv',
      bytes: 1200,
      url: 'https://example.com/video',
      title: 'Private title',
      text: 'private subtitle',
      name: 'private.mkv',
    },
  });
  now += 5;
  await log.append({ level: 'error', scope: 'worker', event: 'source.failed', code: 'TRACK003' });

  const stored = await log.read();
  check('two entries survive', stored.entries.length, 2);
  check('the first is the viewer event', stored.entries[0].event, 'viewer.file');
  check('technical fields are kept', stored.entries[0].detail.ext, 'mkv');
  check('bytes are kept', stored.entries[0].detail.bytes, 1200);
  check('page URLs are dropped', 'url' in stored.entries[0].detail, false);
  check('titles are dropped', 'title' in stored.entries[0].detail, false);
  check('subtitle text is dropped', 'text' in stored.entries[0].detail, false);
  check('file names are dropped', 'name' in stored.entries[0].detail, false);
  check('error codes are kept', stored.entries[1].code, 'TRACK003');
  check('retention defaults to 30', stored.retentionDays, 30);
  check('the storage key is diagnostics', Boolean(bucket.diagnostics), true);
}

section('retention is enforced on read and append');

{
  const start = Date.UTC(2026, 0, 1);
  let now = start;
  const { api } = fakeApi();
  const log = createDiagnostics(api, { now: () => now });
  await log.append({ level: 'info', scope: 'worker', event: 'old' });
  now = start + 31 * 24 * 60 * 60 * 1000;
  await log.append({ level: 'info', scope: 'worker', event: 'new' });
  const stored = await log.read();
  check('the entry older than 30 days is gone', stored.entries.map((e) => e.event), ['new']);
  check('retention is still 30', stored.retentionDays, 30);
}

section('the entry cap is enforced');

{
  const { api } = fakeApi();
  const log = createDiagnostics(api, { now: nowAt(Date.UTC(2026, 0, 1)) });
  for (let i = 0; i < MAX_ENTRIES + 3; i++) {
    await log.append({ level: 'info', scope: 'worker', event: 'e', detail: { count: i } });
  }
  const stored = await log.read();
  check('the log is capped', stored.entries.length, MAX_ENTRIES);
  check('the newest survived', stored.entries.at(-1).detail.count, MAX_ENTRIES + 2);
}

section('corruption is discarded, not rendered');

{
  check('a wrong schema resets', normaliseLog({ schema: 99, entries: [{ t: 1 }] }).entries, []);
  check('a non-object resets', normaliseLog('nope').entries, []);
  check('a bad retention resets to 30', normaliseLog({ schema: 1, retentionDays: 7 }).retentionDays, 30);
  check('an entry without a time is dropped', normaliseLog({ schema: 1, retentionDays: 30, entries: [{ event: 'x' }] }).entries, []);
}

section('retention can change and clear keeps it');

{
  const { api } = fakeApi();
  const log = createDiagnostics(api, { now: nowAt(Date.UTC(2026, 0, 1)) });
  await log.append({ level: 'info', scope: 'worker', event: 'a' });
  await log.setRetention(60);
  const after = await log.read();
  check('retention changed', after.retentionDays, 60);
  check('the entry is still there', after.entries.length, 1);
  await log.clear();
  const cleared = await log.read();
  check('clear removes entries', cleared.entries.length, 0);
  check('clear keeps the retention', cleared.retentionDays, 60);
}

section('export is JSONL with a header');

{
  const { api } = fakeApi();
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const log = createDiagnostics(api, { version: '0.1.0', target: 'firefox', now: () => now });
  await log.append({ level: 'warn', scope: 'content', event: 'content.no-player' });
  const text = await log.exportText(null, { exportedAt: new Date(now).toISOString() });
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  check('the first line is a header', lines[0].type, 'header');
  check('the header carries the version', lines[0].version, '0.1.0');
  check('the header carries the target', lines[0].target, 'firefox');
  check('the header carries the count', lines[0].count, 1);
  check('the entry follows', lines[1].event, 'content.no-player');
  check('the entry has a scope', lines[1].scope, 'content');
  check('the file ends with a newline', text.endsWith('\n'), true);
  check('no page content is in the export', /example\.com|private|subtitle|\.mkv/.test(text), false);
}

section('prune by bytes and ordering');

{
  const base = Date.UTC(2026, 0, 1);
  const entries = Array.from({ length: 2000 }, (_, i) => ({
    schema: 1,
    t: base + i,
    level: 'info',
    scope: 'worker',
    event: 'e',
    code: null,
    detail: { source: 'x'.repeat(60) },
  }));
  const pruned = prune({ schema: 1, retentionDays: 30, entries }, base + 10_000);
  check('ordering is oldest first', pruned.entries[0].t <= pruned.entries.at(-1).t, true);
  check('the byte cap left a real file', pruned.entries.length > 0, true);
  check('the byte cap is not exceeded', new TextEncoder().encode(JSON.stringify(pruned)).length <= 512 * 1024, true);
  check('toJsonl can serialise it', toJsonl(pruned).length > 0, true);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
