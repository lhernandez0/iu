/**
 * Turn `web-ext lint`'s JSON into an exit code and a readable report.
 *
 * The Makefile pipes the linter through here rather than reading its exit code,
 * because the linter exits non-zero on WARNINGS as well as errors, and some warnings
 * are permanent and expected (Firefox says itself that it ignores the Chrome-only
 * manifest keys). Failing on those would mean either living with a red build or
 * disabling the check, and both are worse than classifying the output.
 *
 * ERRORS fail. WARNINGS are checked against the list below: a KNOWN warning passes
 * with its reason printed, and an UNKNOWN one FAILS, because a new warning is a new
 * decision and the point of the split build is that the set goes down over time, not
 * up. `make lint` on the shared manifest reports four; the same command with
 * TARGET=firefox reports one. Both are accounted for here.
 *
 * @see Makefile, `make lint`
 */

/**
 * Warnings we have looked at and accepted, with the reason each is tolerable.
 *
 * Matched on a substring, because the linter's message embeds counts and versions
 * that change and the identity of the warning is the phrase, not the whole line.
 *
 * @type {Array<{match: RegExp, why: string}>}
 */
const ACCEPTED = [
  {
    // Only on the shared (`TARGET=both`) manifest. Removed entirely for both
    // per-browser builds, which is what the split exists for.
    match: /Invalid permissions "sidePanel"/,
    why: 'the shared manifest declares the Chrome panel permission; the Firefox build drops it (make stage TARGET=firefox)',
  },
  {
    // Only on the shared manifest. Firefox uses `background.scripts`, which the same
    // key declares beside it; the Firefox build removes the Chrome-only field.
    match: /Unsupported "\/background\/service_worker" manifest property/,
    why: 'the shared manifest declares both background forms; the Firefox build removes service_worker',
  },
  {
    match: /Manifest key not supported by the specified minimum Firefox version/,
    why: 'the shared manifest sets strict_min_version below the consent key; the Firefox build is linted at 140 where this does not appear',
  },
  {
    // The one that survives the split, and the reason is deliberate: Mozilla reads
    // `data_collection_permissions` from Firefox for Android 142, but this extension
    // does not support Android at all (there is no sidebar there), so no
    // `gecko_android` floor is declared and the linter compares against the default.
    // Declaring 142 would silence it by claiming an Android target we do not ship.
    match: /not supported by the specified minimum Firefox for Android version/,
    why: 'Firefox for Android has no sidebar, so no Android floor is declared; the key is inert there rather than wrong',
  },
];

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let report;
try {
  report = JSON.parse(chunks.join(''));
} catch (error) {
  console.error(`could not read the linter's output: ${error.message}`);
  process.exit(1);
}

const errors = report.errors ?? [];
const warnings = report.warnings ?? [];
const notices = report.notices ?? [];

const line = (kind, entry) => {
  const where = entry.file ? ` [${entry.file}${entry.line ? `:${entry.line}` : ''}]` : '';
  return `  ${kind}  ${entry.message}${where}`;
};

if (errors.length) {
  console.error(`${errors.length} error(s):`);
  for (const entry of errors) console.error(line('ERR ', entry));
}

// A warning is either known, and prints the line that justifies it, or it is new and
// this exits non-zero. The unknown list is what "classify, do not merely tolerate"
// means in practice.
const unknown = warnings.filter(
  (entry) => !ACCEPTED.some(({ match }) => match.test(entry.message)),
);
if (warnings.length) {
  console.log(`${warnings.length} warning(s), ${unknown.length} not already accounted for:`);
  for (const entry of warnings) {
    const known = ACCEPTED.find(({ match }) => match.test(entry.message));
    console.log(line('WARN', entry));
    if (known) console.log(`        accepted: ${known.why}`);
  }
}
if (notices.length) {
  console.log(`${notices.length} notice(s):`);
  for (const entry of notices) console.log(line('NOTE', entry));
}

if (unknown.length) {
  console.error(
    `\n${unknown.length} warning(s) are not in tools/check-lint.mjs's accepted list.` +
      `\nEither fix the cause, or add it there with the reason it is tolerable.`,
  );
}

if (!errors.length && !unknown.length) {
  console.log(`lint clean, ${errors.length} errors, ${warnings.length} warnings (all accounted for)`);
}
process.exit(errors.length || unknown.length ? 1 : 0);
