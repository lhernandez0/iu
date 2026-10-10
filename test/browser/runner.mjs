/**
 * The small runner shared by both browser tiers.
 *
 * Suites are plain scripts that take a context, report checks, and exit
 * non-zero on failure, the same convention as the hermetic suites, so there is
 * one way to write a test in this repo.
 *
 * `describe()` handles the two things a browser suite needs that a pure one
 * does not: it launches and tears down the browser exactly once, and it treats a
 * missing browser as a skip rather than a failure, so a machine without one can
 * still run the rest of the suite.
 */

import { launchExtension, BrowserUnavailable } from './harness.mjs';

/**
 * @returns {{check: Function, section: Function, failures: () => number, checks: () => number, done: Function}}
 */
export function createReporter() {
  let failures = 0;
  let checks = 0;

  return {
    check(name, actual, expected) {
      checks++;
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a === e) {
        console.log(`  pass  ${name}`);
      } else {
        console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`);
        failures++;
      }
    },
    section(name) {
      console.log(`\n${name}`);
    },
    failures: () => failures,
    checks: () => checks,
    done() {
      console.log(`\n${checks - failures}/${checks} checks passed`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
}

/**
 * Run a browser tier.
 *
 * @param {(launch: object, report: object) => Promise<void>} body
 */
export async function runBrowserSuite(body) {
  const report = createReporter();

  let launch;
  try {
    launch = await launchExtension();
  } catch (error) {
    if (error instanceof BrowserUnavailable) {
      // One extension launch serves every case in the file, because launching
      // Chromium takes longer than the cases themselves.
      console.log(`SKIP  ${error.message}`);
      process.exit(0);
    }
    throw error;
  }

  try {
    await body(launch, report);
  } catch (error) {
    // A suite that throws has not finished, whatever its checks said. Report it
    // as a failure rather than letting the count decide, otherwise a suite that
    // passed four checks and then crashed would exit green.
    console.log(`\nSUITE ERROR: ${error?.stack ?? error}`);
    console.log(`\n${report.checks() - report.failures()}/${report.checks()} checks passed before the failure`);
    process.exitCode = 1;
    await launch.close().catch(() => {});
    process.exit(1);
  }

  await launch.close();
  report.done();
}
