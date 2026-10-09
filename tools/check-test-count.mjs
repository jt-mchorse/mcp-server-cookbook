#!/usr/bin/env node
//
// Assert that a server's just-measured test-case count matches its entry in
// `tools/test-counts.json` (#166).
//
// This is the freshness half of the lock. `check-readme.mjs` holds the READMEs
// to the counts file and enforces `static <= runtime`, but both of those read
// files — neither can tell a stale entry from a current one. This step runs in
// each server's own CI job, after the suite that job already runs, and compares
// what actually executed.
//
// Usage:
//   node tools/check-test-count.mjs <server> <report-path>
//
// The report is whichever machine-readable output that server's runner emits:
//   - vitest  `--reporter=json --outputFile.json=<path>`  -> numPassedTests
//   - pytest  `--junitxml=<path>`                          -> tests - skipped
//
// Both are additional flags on the run the job already performs, so nothing is
// executed twice.
//
// The unit is *executed, non-skipped cases* — the number the human-readable
// output prints and the number the README quotes. A skipped test is not a test
// the reader can count in the terminal, and counting it would make the claim
// depend on which optional extras the runner happened to have.
//
// Exit codes:
//   0 — the measured count matches
//   1 — drift: the counts file disagrees with what ran
//   2 — bad input (unknown server, missing/unparseable report, bad arguments)

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TEST_COUNTS_PATH = path.join(REPO_ROOT, "tools/test-counts.json");

/**
 * Number of executed, non-skipped cases in a vitest JSON report.
 *
 * `numPassedTests`, not `numTotalTests`: a failing run should fail on the test
 * failure, not additionally on a count mismatch that says nothing useful.
 */
export function countFromVitestJson(text) {
  const report = JSON.parse(text);
  if (typeof report.numPassedTests !== "number") {
    throw new Error("vitest JSON report has no numeric `numPassedTests`");
  }
  return report.numPassedTests;
}

/**
 * Number of executed, non-skipped cases in a pytest JUnit XML report.
 *
 * `tests` counts everything collected including skips, so the skipped and
 * errored attributes come off — which matters here specifically: this repo's
 * Python suite skips its MCP-SDK round-trip tests when the `[server]` extra is
 * absent, so the collected total moves with the install line while the number
 * a reader sees printed does not.
 */
export function countFromJunitXml(text) {
  const suites = [...text.matchAll(/<testsuite\b[^>]*>/g)];
  if (suites.length === 0) throw new Error("no <testsuite> element in JUnit report");
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\b${name}="(\\d+)"`));
    return m ? Number(m[1]) : 0;
  };
  let total = 0;
  for (const [tag] of suites) {
    const tests = tag.match(/\btests="(\d+)"/);
    if (!tests) continue;
    total += Number(tests[1]) - attr(tag, "skipped") - attr(tag, "errors");
  }
  return total;
}

export function countFromReport(reportPath, text) {
  if (reportPath.endsWith(".json")) return countFromVitestJson(text);
  if (reportPath.endsWith(".xml")) return countFromJunitXml(text);
  throw new Error(`unrecognised report format: ${reportPath} (expected .json or .xml)`);
}

export function readRecordedCounts(text) {
  const parsed = JSON.parse(text);
  const counts = parsed?.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("test-counts.json must have an object `counts` field");
  }
  return counts;
}

function main(argv) {
  const [server, reportPath] = argv;
  if (!server || !reportPath) {
    process.stderr.write("usage: check-test-count.mjs <server> <report-path>\n");
    return 2;
  }
  if (!existsSync(TEST_COUNTS_PATH)) {
    process.stderr.write(`test-counts.json not found at ${TEST_COUNTS_PATH}\n`);
    return 2;
  }
  if (!existsSync(reportPath)) {
    process.stderr.write(`report not found at ${reportPath}\n`);
    return 2;
  }

  let counts;
  let measured;
  try {
    counts = readRecordedCounts(readFileSync(TEST_COUNTS_PATH, "utf-8"));
    measured = countFromReport(reportPath, readFileSync(reportPath, "utf-8"));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  const recorded = counts[server];
  if (recorded === undefined) {
    process.stderr.write(
      `tools/test-counts.json has no entry for \`${server}\`. Every server whose ` +
        `count the README quotes needs one.\n`,
    );
    return 2;
  }
  if (recorded !== measured) {
    process.stderr.write(
      `error: ${server} ran ${measured} test case(s) but tools/test-counts.json ` +
        `records ${recorded}. Update the counts file to ${measured} and the ` +
        `README lines that quote it — that is the whole point of this check, so ` +
        `the number a reader sees is the number the command prints.\n`,
    );
    return 1;
  }
  process.stdout.write(`test-count ok: ${server} = ${measured}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
