/**
 * Turn `web-ext lint`'s JSON into an exit code and a readable report.
 *
 * The Makefile pipes the linter through here rather than reading its exit code,
 * because the linter exits non-zero on WARNINGS as well as errors — and two of our
 * warnings are permanent and expected (Firefox says itself that it ignores the
 * Chrome-only manifest keys). Failing on those would mean either living with a red
 * build or disabling the check, and both are worse than classifying the output.
 *
 * ERRORS fail. WARNINGS are printed and pass, because a warning we have looked at
 * and accepted is not the same as one nobody has seen.
 *
 * @see Makefile — `make lint`
 */

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
if (warnings.length) {
  console.log(`${warnings.length} warning(s), none fatal:`);
  for (const entry of warnings) console.log(line('WARN', entry));
}
if (notices.length) {
  console.log(`${notices.length} notice(s):`);
  for (const entry of notices) console.log(line('NOTE', entry));
}

if (!errors.length) {
  console.log(`lint clean — ${errors.length} errors, ${warnings.length} warnings`);
}
process.exit(errors.length ? 1 : 0);
