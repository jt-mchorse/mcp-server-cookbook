// Tests for tools/check-architecture-doc.mjs.
//
// Uses node:test (stdlib) so this file is runnable without installing
// vitest or jest. The CI job runs `node --test tools/check-architecture-doc.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  archServerRefs,
  findStalePhrases,
  STALE_PHRASES,
  activeDecisions,
  findUnreferencedDecisions,
  findUnreferencedShippedIssues,
  MIN_ACTIVE_DECISION_ID,
  KNOWN_SHIPPED_ISSUES,
} from "./check-architecture-doc.mjs";

test("archServerRefs collects unique servers/<name> references in path form", () => {
  const md = [
    "see `servers/postgres-readonly/README.md` for details",
    "diagram has `│   ├── filesystem-sandbox/`",
    "and `servers/github-gists/` again",
    "  and once more `servers/postgres-readonly/` (dup)",
  ].join("\n");
  assert.deepEqual(archServerRefs(md), [
    "github-gists",
    "postgres-readonly",
  ]);
});

test("archServerRefs accepts hyphenated and numeric server names", () => {
  const md = "servers/filesystem-sandbox-py and servers/foo-bar-99";
  assert.deepEqual(archServerRefs(md), ["filesystem-sandbox-py", "foo-bar-99"]);
});

test("archServerRefs rejects identifiers without the leading `servers/`", () => {
  const md = "this mentions `postgres-readonly` and `filesystem-sandbox` but not as paths";
  assert.deepEqual(archServerRefs(md), []);
});

test("STALE_PHRASES contains the four shapes of #22 drift, in declared order", () => {
  // Hard-pin the set in the test so a future loose edit of the checker
  // can't silently drop one of the banned phrases.
  assert.deepEqual(STALE_PHRASES, [
    "api-with-auth",
    "pending issue",
    "pending (not yet filed)",
    "this PR",
  ]);
});

test("findStalePhrases returns empty for clean markdown", () => {
  const md = [
    "# Architecture",
    "",
    "five servers ship: postgres-readonly, filesystem-sandbox, ",
    "filesystem-sandbox-py, github-gists, internal-tools-bridge.",
  ].join("\n");
  assert.deepEqual(findStalePhrases(md), []);
});

test("findStalePhrases catches each banned phrase individually", () => {
  for (const phrase of STALE_PHRASES) {
    const md = `clean prose around the phrase ${phrase} and more after`;
    const hits = findStalePhrases(md);
    assert.equal(hits.length, 1, `expected exactly one hit for "${phrase}"`);
    assert.equal(hits[0].phrase, phrase);
    assert.ok(hits[0].index > 0, `expected non-zero index for "${phrase}"`);
  }
});

test("findStalePhrases catches multiple phrases in the same source", () => {
  const md = [
    "this PR ships `api-with-auth` as a pending issue tracked as",
    "pending (not yet filed) until later.",
  ].join("\n");
  const hits = findStalePhrases(md);
  const phrases = hits.map((h) => h.phrase).sort();
  assert.deepEqual(phrases, [...STALE_PHRASES].sort());
});

test("MIN_ACTIVE_DECISION_ID is hard-pinned to 2", () => {
  // D-001 is the baseline "scope per handoff §2" entry every repo
  // carries and isn't load-bearing in per-server text, so the lower
  // bound is D-002. Hard-pinned here so a future loose edit can't
  // silently widen the skip set and quietly drop architectural
  // decisions from the coverage check.
  assert.equal(MIN_ACTIVE_DECISION_ID, 2);
});

test("KNOWN_SHIPPED_ISSUES is hard-pinned to [1..5]", () => {
  // Issues #1..#5 are the five shipped cookbook entries (postgres-readonly,
  // filesystem-sandbox, github-gists, internal-tools-bridge, filesystem-
  // sandbox-py). A sixth entry shipping under #N requires bumping this
  // array AND adding a doc reference; this hard-pin makes the former
  // unmissable.
  assert.deepEqual([...KNOWN_SHIPPED_ISSUES], [1, 2, 3, 4, 5]);
});

test("activeDecisions returns sorted ids >= MIN_ACTIVE_DECISION_ID and skips superseded", () => {
  const md = [
    "- id: D-001",
    "  superseded_by: null",
    "",
    "- id: D-002",
    "  superseded_by: null",
    "",
    "- id: D-003",
    "  superseded_by: D-007",
    "",
    "- id: D-005",
    "  superseded_by: null",
    "",
    "- id: D-004",
    "  superseded_by: null",
    "",
  ].join("\n");
  // D-001 below the floor, D-003 superseded, rest active and sorted.
  assert.deepEqual(activeDecisions(md), [2, 4, 5]);
});

test("activeDecisions skips entries missing superseded_by (treats as active only when explicitly null)", () => {
  // Real entries always carry superseded_by; if a future entry omits
  // the field, treating it as active by default matches the existing
  // schema and matches sister-repo behavior (llm-eval-harness'
  // architecture-doc test does the same).
  const md = [
    "- id: D-010",
    "  date: 2026-05-01",
    "  decision: example",
    "",
    "- id: D-011",
    "  superseded_by: D-099",
    "",
  ].join("\n");
  assert.deepEqual(activeDecisions(md), [10]);
});

test("activeDecisions strips leading zeros consistently (id is integer-valued)", () => {
  const md = [
    "- id: D-007",
    "  superseded_by: null",
    "",
    "- id: D-042",
    "  superseded_by: null",
    "",
  ].join("\n");
  assert.deepEqual(activeDecisions(md), [7, 42]);
});

test("findUnreferencedDecisions returns empty when all active ids are cited", () => {
  const md = "lock D-002 ships under D-007; see also D-9 in passing.";
  assert.deepEqual(findUnreferencedDecisions(md, [2, 7, 9]), []);
});

test("findUnreferencedDecisions flags the missing ids and preserves input order", () => {
  // Note: the synthetic doc must NOT contain the literal "D-NNN" token
  // for any id we claim is missing, since the function scans the input
  // for any D-NNN occurrence. Mention only D-002 and D-007.
  const md = "doc mentions D-002 in section A and D-007 in section B.";
  assert.deepEqual(findUnreferencedDecisions(md, [2, 5, 7, 9]), [5, 9]);
});

test("findUnreferencedDecisions tolerates leading zeros in citations", () => {
  // The doc may cite D-007, D-07, or D-7 — all mean the same id.
  const md = "see D-007 and also D-7 plus D-07.";
  assert.deepEqual(findUnreferencedDecisions(md, [7]), []);
});

test("findUnreferencedShippedIssues returns empty when all issues are cited", () => {
  const md =
    "closes #1, #2, #3 in the diagram; the section on #4 references #5 too.";
  assert.deepEqual(findUnreferencedShippedIssues(md), []);
});

test("findUnreferencedShippedIssues returns the missing issue numbers in declared order", () => {
  const md = "only #1 and #4 appear in this doc.";
  assert.deepEqual(findUnreferencedShippedIssues(md), [2, 3, 5]);
});

test("checker integration: docs/architecture.md is currently clean", async () => {
  // Run the script as a subprocess so we exercise main() end-to-end
  // against the real doc, not a synthetic fixture. This guards against
  // a regression where someone edits architecture.md and forgets to
  // re-run the check locally.
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const path = (await import("node:path")).default;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(__dirname, "check-architecture-doc.mjs");

  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `check-architecture-doc.mjs failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  assert.match(result.stdout, /check ok:/);
});
