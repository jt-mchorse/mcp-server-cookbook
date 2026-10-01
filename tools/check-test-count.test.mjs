// Tests for tools/check-test-count.mjs.
//
// Uses node:test (stdlib) so this file is runnable without installing vitest
// or jest. The CI job runs `node --test tools/check-test-count.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  countFromJunitXml,
  countFromReport,
  countFromVitestJson,
  readRecordedCounts,
} from "./check-test-count.mjs";
import { countTestsInServer, serverReadmeTestCountClaims } from "./check-readme.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("countFromVitestJson reads the passed count, not the total", () => {
  const report = JSON.stringify({
    numTotalTests: 190,
    numPassedTests: 185,
    numPendingTests: 5,
  });
  // `numPassedTests`: a failing run should fail on the failure, not
  // additionally on a count mismatch that says nothing useful.
  assert.equal(countFromVitestJson(report), 185);
});

test("countFromVitestJson rejects a report with no numeric count", () => {
  assert.throws(() => countFromVitestJson("{}"), /numPassedTests/);
});

test("countFromJunitXml subtracts skips and errors from the collected total", () => {
  const xml =
    '<testsuites><testsuite name="pytest" errors="0" failures="0" skipped="3" tests="253"' +
    ' time="0.4"></testsuite></testsuites>';
  // 253 collected, 3 skipped -> the 250 the terminal prints. This is not
  // hypothetical here: the Python suite skips its MCP-SDK round-trip tests
  // without the `[server]` extra, so the collected total moves with the
  // install line while the printed number does not.
  assert.equal(countFromJunitXml(xml), 250);
});

test("countFromJunitXml sums multiple testsuite elements", () => {
  const xml =
    '<testsuites><testsuite tests="10" skipped="0"></testsuite>' +
    '<testsuite tests="5" skipped="2"></testsuite></testsuites>';
  assert.equal(countFromJunitXml(xml), 13);
});

test("countFromJunitXml refuses a report with no testsuite", () => {
  assert.throws(() => countFromJunitXml("<other/>"), /testsuite/);
});

test("countFromReport dispatches on the extension and refuses anything else", () => {
  assert.equal(countFromReport("r.json", JSON.stringify({ numPassedTests: 7 })), 7);
  assert.equal(countFromReport("r.xml", '<testsuite tests="7" skipped="0"/>'), 7);
  assert.throws(() => countFromReport("r.txt", "7"), /unrecognised report format/);
});

test("readRecordedCounts requires an object `counts` field", () => {
  assert.deepEqual(readRecordedCounts('{"counts":{"a":1}}'), { a: 1 });
  assert.throws(() => readRecordedCounts("{}"), /counts/);
  assert.throws(() => readRecordedCounts('{"counts":[]}'), /counts/);
});

// --- the unit itself, which is the whole point of #166 --------------------

test("the recorded counts are strictly above the static counts", () => {
  // The wrong-unit rejection arm. Before #166 the README quoted the *static*
  // count — test functions, times a parametrize factor the counter can only
  // sometimes resolve — beside a command that prints *cases*. Every one of the
  // five was roughly half the truth.
  //
  // This asserts the two units are genuinely different for every server, so a
  // future edit that quietly swaps the recorded number back to the static one
  // fails here rather than being frozen in place by a self-consistent lock.
  const counts = readRecordedCounts(
    readFileSync(path.join(REPO_ROOT, "tools/test-counts.json"), "utf-8"),
  );
  const servers = Object.keys(counts);
  assert.ok(servers.length >= 5, `expected at least 5 servers, got ${servers.length}`);

  for (const server of servers) {
    const staticCount = countTestsInServer(path.join(REPO_ROOT, "servers", server)).total;
    assert.ok(
      staticCount > 0,
      `${server}: the static counter found nothing, so this comparison is vacuous`,
    );
    assert.ok(
      staticCount <= counts[server],
      `${server}: static ${staticCount} exceeds recorded runtime ${counts[server]}, ` +
        "which is impossible — every test function yields at least one case",
    );
    assert.notEqual(
      staticCount,
      counts[server],
      `${server}: the recorded count equals the static count. That is the wrong ` +
        "unit — the README quotes what the command prints, and parametrized " +
        "tables make those two numbers differ for every server here.",
    );
  }
});

test("every server directory has a recorded count", () => {
  // Discovered from the filesystem, not listed: a sixth server added without an
  // entry would otherwise carry an unlocked README claim, which is the state
  // that let `filesystem-sandbox-py`'s number drift by more than 4x.
  const dirs = readdirSync(path.join(REPO_ROOT, "servers"))
    .filter(
      (e) =>
        !e.startsWith(".") && statSync(path.join(REPO_ROOT, "servers", e)).isDirectory(),
    )
    .sort();
  const counts = readRecordedCounts(
    readFileSync(path.join(REPO_ROOT, "tools/test-counts.json"), "utf-8"),
  );
  assert.ok(dirs.length > 0, "no server directories discovered");
  assert.deepEqual(dirs, Object.keys(counts).sort());
});

test("the shipped per-server README claims match the recorded counts", () => {
  // Independent of `check-readme.mjs`'s main(): a check cannot lock itself
  // against its own deletion. Removing the per-server block from that script
  // silently restores the state this issue is about — a claim nothing reads —
  // and only an assertion living somewhere else notices.
  //
  // The floor used to be ">= 2", and it could not see the two claims the
  // parser missed (#179): a claim that never parses is not counted, so a floor
  // on what parsed is satisfied by the claims that happen to be well-worded.
  // Pin the SET of servers that make a claim instead.
  const counts = readRecordedCounts(
    readFileSync(path.join(REPO_ROOT, "tools/test-counts.json"), "utf-8"),
  );
  let found = 0;
  const claiming = new Set();
  for (const server of Object.keys(counts)) {
    const readmePath = path.join(REPO_ROOT, "servers", server, "README.md");
    if (!existsSync(readmePath)) continue;
    for (const claim of serverReadmeTestCountClaims(readFileSync(readmePath, "utf-8"))) {
      found += 1;
      claiming.add(server);
      assert.equal(
        claim.count,
        counts[server],
        `servers/${server}/README.md claims ${claim.count} tests, recorded ` +
          `${counts[server]}. Line: ${claim.line.trim()}`,
      );
    }
  }
  assert.deepEqual(
    [...claiming].sort(),
    ["filesystem-sandbox", "filesystem-sandbox-py", "github-gists", "internal-tools-bridge"],
    `servers whose README makes a test-count claim the parser reads (found ${found})`,
  );
});

test("a per-server claim parses with words between the number and 'tests' (#179)", () => {
  // The old regex needed the number flush against "tests", so both of these
  // wordings were skipped silently and their stale numbers (38, 28) went unchecked.
  const claims = (line) => serverReadmeTestCountClaims("```bash\n" + line + "\n```\n").map((c) => c.count);
  assert.deepEqual(claims("npm test                # 185 hermetic vitest tests"), [185]);
  assert.deepEqual(claims("npm test    # vitest, 167 hermetic unit tests, no network"), [167]);
  assert.deepEqual(claims("npm test    # 67 tests (30 bridge, 37 client)"), [67]);
  // Neighbours that must NOT read as a claim.
  assert.deepEqual(claims("npm run bench   # ~60 ms end to end"), []);
  assert.deepEqual(claims("git log         # see #166 tests"), []);
  assert.deepEqual(claims("ls src          # 5 files"), []);
});
