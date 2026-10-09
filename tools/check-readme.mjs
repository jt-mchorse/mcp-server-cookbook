#!/usr/bin/env node
//
// Verify the top-level README's claims about the servers match reality.
//
// Two invariants:
//   1. Server-dir references: every `servers/<name>/` referenced in README.md
//      points to an existing directory.
//   2. Per-server test-count quotes: every line in the Quickstart's "Test
//      suites are hermetic" block that quotes a number of tests for a named
//      server matches that server's entry in `tools/test-counts.json` — the
//      RUNTIME CASE COUNT, i.e. the number the command on that very line
//      prints (#166).
//
//      The unit is the whole point and it used to be wrong. This check
//      compared the claims against the *static* count below — test functions
//      times a parametrize factor it can only sometimes resolve — while the
//      README sentence annotates a command, and what a command prints is
//      cases. All five claims were roughly half the truth (87 vs 185, 132 vs
//      250, 98 vs 167, 49 vs 67, 190 vs 276), and the lock is why nobody
//      noticed: it made each claim self-consistent with an approximation and
//      froze it there.
//
//   3. Static floor: the static count must be <= the runtime count for every
//      server. That is a real invariant — every `it(` / `def test_` yields at
//      least one case — so a hand-lowered `test-counts.json` cannot pass. The
//      freshness half lives in each server's own CI job, which asserts its
//      measured count equals its entry after running the suite it already
//      runs. Two independent checks that one stale number cannot satisfy.
//
// This script is still static: it reads files, doesn't run them.
// It runs in CI on every PR with a dedicated `readme-check` job.
//
// Exit codes:
//   0 — all claims match reality
//   1 — drift detected; one or more claims fail
//   2 — bad input (missing README, malformed Quickstart block, no servers)
//

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
// Overridable only so a test can run this script, end to end, against an edited
// copy of the real README (#215): the coverage rule is worthless if `main`
// stops calling it, and a unit test of the rule cannot see that.
const README_PATH = process.env.MCP_CHECK_README_PATH ?? path.join(REPO_ROOT, "README.md");
const SERVERS_DIR = path.join(REPO_ROOT, "servers");
const DECISIONS_PATH = path.join(REPO_ROOT, "MEMORY/core_decisions_ai.md");
const TEST_COUNTS_PATH = path.join(REPO_ROOT, "tools/test-counts.json");

/**
 * Parse `MEMORY/core_decisions_ai.md` and return the highest active
 * (non-superseded) `D-NNN` integer id. Returns 0 if no active entries
 * are found.
 *
 * Mirrors the shape of `tools/check-architecture-doc.mjs`'s
 * `activeDecisions(decisionsMd)` parser — same regex anchors, same
 * superseded_by handling, but folded down to a single max. Kept here
 * rather than imported so this script stays dep-free and the two
 * tools don't grow a circular relationship.
 */
export function maxActiveDecisionId(decisionsMd) {
  const blocks = decisionsMd.split(/\n(?=- id:)/);
  let best = 0;
  for (const block of blocks) {
    const idMatch = block.match(/- id:\s*D-(\d+)/);
    if (!idMatch) continue;
    const supMatch = block.match(/superseded_by:\s*(\S+)/);
    const supValue = supMatch ? supMatch[1].trim().toLowerCase() : "null";
    if (supValue !== "null") continue;
    const n = Number.parseInt(idMatch[1], 10);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/**
 * Return the upper bound `N` cited in the README's `D-002…D-N`
 * range citation, or null if no such range is found. Accepts both the
 * unicode ellipsis (`D-002…D-N`) and the ASCII three-dot form
 * (`D-002...D-N`).
 */
export function readmeDecisionRangeBound(markdown) {
  const matches = Array.from(
    markdown.matchAll(/D-0*2\s*(?:…|\.\.\.)\s*D-0*(\d+)/g),
  ).map((m) => Number.parseInt(m[1], 10));
  if (matches.length === 0) return null;
  return Math.max(...matches);
}

/**
 * Collect every `servers/<name>/` substring from the README and return the
 * unique set of `<name>` values.
 */
export function readmeServerRefs(markdown) {
  const re = /servers\/([a-z0-9][a-z0-9-]*[a-z0-9])\b/g;
  const names = new Set();
  for (const m of markdown.matchAll(re)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Find the Quickstart "Test suites are hermetic" block and parse out each
 * `cd servers/<name> ... # <N> ...` claim.
 *
 * Returns an array of `{ server, count, line }` records.
 */
export function readmeTestCountClaims(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    // Match: cd servers/<name> ... # <count> <some words> tests
    // Tolerant of extra commands before the `#`. The count is read after the
    // FIRST `#` -- the shell comment -- and anything may follow it. The old
    // pattern ended in `[^#]*$`, so a `#212` anywhere in the description made
    // the line stop being a claim at all, and the check passed with one claim
    // fewer: a README quoting 9999 tests for a 74-test server went green (#215).
    const m = line.match(
      /^cd servers\/([a-z0-9][a-z0-9-]*[a-z0-9])\b[^#]*#\s*(\d+)(?:\s|$)/,
    );
    if (!m) continue;
    out.push({ server: m[1], count: Number(m[2]), line });
  }
  return out;
}

/**
 * Every server directory must carry exactly one root test-count claim (#215).
 *
 * The count lock compares each claim it *finds*; a claim it does not find was
 * never compared. A deleted Quickstart line, or one whose count stopped
 * parsing, used to shrink the claim list and pass. Returns one error per
 * server with no claim or with more than one.
 */
export function claimCoverageErrors(claims, serverDirs) {
  const errors = [];
  for (const server of [...serverDirs].sort()) {
    const n = claims.filter((c) => c.server === server).length;
    if (n === 0) {
      errors.push(
        `\`servers/${server}/\` has no root README test-count claim. Every server's ` +
          `Quickstart line must read \`cd servers/${server} ... # <N> ... tests\`; a line ` +
          `that was deleted, or whose count no longer parses, is not checked at all.`,
      );
    } else if (n > 1) {
      errors.push(
        `\`servers/${server}/\` has ${n} root README test-count claims; keep exactly one.`,
      );
    }
  }
  return errors;
}

/**
 * Walk a directory and return every `*.test.ts` / `*.test.tsx` / `*.test.mjs`
 * / `test_*.py` / `*_test.py` file.
 */
function walkTestFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".venv" || entry.startsWith(".")) {
      continue;
    }
    const p = path.join(dir, entry);
    const stat = statSync(p);
    if (stat.isDirectory()) {
      out.push(...walkTestFiles(p));
    } else if (
      entry.endsWith(".test.ts") ||
      entry.endsWith(".test.tsx") ||
      entry.endsWith(".test.mjs") ||
      entry.endsWith(".test.js") ||
      /^test_.*\.py$/.test(entry) ||
      /_test\.py$/.test(entry)
    ) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Count top-level commas in a single-line `[...]` literal. Honors single and
 * double-quoted strings (with `\` escapes); does not handle nested brackets
 * (no current parametrize usage in this repo nests them).
 */
export function topLevelCommasInList(listSrc) {
  // listSrc must start with `[` and end with `]`.
  if (listSrc.length < 2 || listSrc[0] !== "[" || listSrc[listSrc.length - 1] !== "]") {
    return null;
  }
  let n = 0;
  let i = 1;
  const end = listSrc.length - 1;
  while (i < end) {
    const ch = listSrc[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < end && listSrc[i] !== quote) {
        if (listSrc[i] === "\\" && i + 1 < end) i += 2;
        else i += 1;
      }
      i += 1; // closing quote
      continue;
    }
    if (ch === ",") n += 1;
    i += 1;
  }
  return n;
}

/**
 * Given a `@pytest.mark.parametrize(...)` line, return the case count by
 * parsing the second argument's `[...]` literal. Returns null if the line
 * can't be parsed (caller falls back to 1).
 */
export function parametrizeCases(parametrizeLine) {
  const start = parametrizeLine.indexOf("[");
  const last = parametrizeLine.lastIndexOf("]");
  if (start < 0 || last < 0 || last < start) return null;
  const list = parametrizeLine.slice(start, last + 1);
  const commas = topLevelCommasInList(list);
  if (commas === null) return null;
  return commas + 1;
}

/**
 * Remove the *contents* of single-quoted, double-quoted, and template-literal
 * strings from a line, leaving the surrounding code intact. Honors `\` escapes;
 * an unterminated quote (a multi-line string) is stripped to end-of-line.
 *
 * Used by the JS/TS test counter so an `it(` / `test(` that appears inside a
 * test's *description* string (e.g. `it("wraps it() call", ...)`) — or a `//`
 * inside a URL string — isn't mistaken for a real call site. Mirrors the
 * quote-skipping already in `topLevelCommasInList`.
 */
export function stripStringLiterals(line) {
  let out = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < n && line[i] !== quote) {
        if (line[i] === "\\" && i + 1 < n) i += 2;
        else i += 1;
      }
      i += 1; // consume the closing quote (or run past EOL if unterminated)
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Count test cases in a single file. Strategy:
 *   - .ts / .tsx / .js / .mjs → count `it(`, `it.skip(`, `it.only(`,
 *     `test(`, `test.skip(`, `test.only(`, with `.each(...)` chains — only at
 *     column boundaries (preceded by whitespace, `(`, `;`, `{`, or
 *     start-of-line) to avoid matching identifiers that happen to contain
 *     `test`. String literals are stripped first (via `stripStringLiterals`)
 *     so an `it(`/`test(` inside a description string isn't double-counted.
 *   - .py → count `def test_*(` at line start (possibly indented), multiplied
 *     by the product of immediately-preceding `@pytest.mark.parametrize(...)`
 *     decorators' case counts.
 *
 * Comment lines (`//`, `#`) are skipped for counting; for Python, comments
 * between a decorator and the def are tolerated.
 */
export function countTestsInFile(filePath, source) {
  const lines = source.split(/\r?\n/);
  let n = 0;
  if (filePath.endsWith(".py")) {
    let pendingFactor = 1;
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("@pytest.mark.parametrize")) {
        const cases = parametrizeCases(trimmed);
        pendingFactor *= cases == null ? 1 : cases;
        continue;
      }
      if (/^def\s+test_[A-Za-z0-9_]*\s*\(/.test(trimmed)) {
        n += pendingFactor;
        pendingFactor = 1;
        continue;
      }
      // Any other non-blank, non-comment line breaks the decorator chain.
      // (Decorators can stack — but only adjacent to each other before the def.)
      if (!trimmed.startsWith("@")) {
        pendingFactor = 1;
      }
    }
    return n;
  }
  // JS/TS family
  for (const raw of lines) {
    // Strip string literals first so an `it(`/`test(` inside a description
    // (`it("wraps it() call", ...)`) isn't counted, then drop any trailing
    // `//` line comment — real `//` inside a string is already gone, so this
    // also subsumes the old whole-line-comment skip.
    const line = stripStringLiterals(raw.trim()).split("//")[0];
    const re =
      /(^|[\s;\{(])(it|test)(\.skip|\.only|\.each\([^)]*\)|\.failing)?\s*\(/g;
    let m;
    while ((m = re.exec(line)) !== null) n += 1;
  }
  return n;
}

/**
 * Count test cases across every test file in the server's directory.
 */
export function countTestsInServer(serverDir) {
  const files = walkTestFiles(serverDir);
  let total = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    total += countTestsInFile(f, src);
  }
  return { total, files: files.length };
}

/**
 * Read `tools/test-counts.json` and return its `counts` map.
 *
 * Throws rather than returning an empty map on a missing or malformed file:
 * an empty map would make every claim report "no entry" — noisy but survivable
 * — while a silently-empty one under a future refactor would make the floor
 * check vacuous. Bad input is exit 2, not exit 1; it is not drift.
 */
export function readRuntimeCounts() {
  if (!existsSync(TEST_COUNTS_PATH)) {
    throw new Error(`test-counts.json not found at ${TEST_COUNTS_PATH}`);
  }
  const parsed = JSON.parse(readFileSync(TEST_COUNTS_PATH, "utf-8"));
  const counts = parsed?.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("test-counts.json must have an object `counts` field");
  }
  for (const [server, n] of Object.entries(counts)) {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `test-counts.json: ${server} must be a non-negative integer, got ${JSON.stringify(n)}`,
      );
    }
  }
  return counts;
}

/**
 * Find test-count claims inside a single server's own README.
 *
 * Shape: a shell line whose trailing `#` comment quotes a number of tests —
 * `pytest  # 250 tests, ~60 ms`, `npm test  # 67 tests (30 bridge, ...)`.
 * Same unit as the root README: what the command on that line prints.
 *
 * Nothing checked these until #166. `servers/filesystem-sandbox-py`'s said
 * **60** against a real 250 — off by more than 4x and drifting for a long time
 * (#161) — while `servers/internal-tools-bridge`'s said 67 and was exactly
 * right. That is not a coincidence worth ignoring: the one claim somebody kept
 * current is in the runtime unit, which is the unit a reader can check by
 * running the line above it.
 *
 * Returns `{ count, line }` records; a README with no claim yields none, and
 * the check is that a claim that exists is true, not that every server makes
 * one. (This said "which is the case for three of the five servers"; two of
 * those three did make a claim the narrower pattern could not parse, #179.)
 */
export function serverReadmeTestCountClaims(markdown) {
  const out = [];
  for (const raw of markdown.split(/\r?\n/)) {
    // A number, then up to three words, then `test(s)`, anywhere in the line's
    // trailing `#` comment (#179). This required the number flush against both
    // the `#` and `tests`, so `# 38 hermetic vitest tests` and
    // `# vitest, 28 hermetic unit tests` read as "no claim" -- and they were
    // the two stale ones (runtime 185 and 167). `(?<![#\d])` keeps an issue
    // reference like `#166` from ever being a count.
    const m = raw.match(/#[^\n]*?(?<![#\d])\b(\d+)\s+(?:[A-Za-z-]+,?\s+){0,3}tests?\b/);
    if (!m) continue;
    out.push({ count: Number(m[1]), line: raw });
  }
  return out;
}

function listServerDirs() {
  if (!existsSync(SERVERS_DIR)) return [];
  return readdirSync(SERVERS_DIR)
    .filter((entry) => {
      const p = path.join(SERVERS_DIR, entry);
      return statSync(p).isDirectory() && !entry.startsWith(".");
    })
    .sort();
}

function main() {
  if (!existsSync(README_PATH)) {
    process.stderr.write(`README not found at ${README_PATH}\n`);
    return 2;
  }
  const readme = readFileSync(README_PATH, "utf-8");
  const refs = readmeServerRefs(readme);
  const claims = readmeTestCountClaims(readme);
  const serverDirs = new Set(listServerDirs());
  let runtimeCounts;
  try {
    runtimeCounts = readRuntimeCounts();
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  if (serverDirs.size === 0) {
    process.stderr.write(`no server directories found under ${SERVERS_DIR}\n`);
    return 2;
  }
  if (refs.length === 0) {
    process.stderr.write(
      "README contains zero `servers/<name>/` references — has the catalog block been removed?\n",
    );
    return 2;
  }

  const errors = [...claimCoverageErrors(claims, serverDirs)];

  for (const ref of refs) {
    if (!serverDirs.has(ref)) {
      errors.push(
        `README references \`servers/${ref}/\` but no such directory exists.`,
      );
    }
  }

  for (const claim of claims) {
    const serverPath = path.join(SERVERS_DIR, claim.server);
    if (!existsSync(serverPath)) {
      errors.push(
        `README quotes a test count for \`servers/${claim.server}/\` but that directory does not exist.`,
      );
      continue;
    }
    const expected = runtimeCounts[claim.server];
    if (expected === undefined) {
      errors.push(
        `README quotes a test count for \`servers/${claim.server}/\` but ` +
          `tools/test-counts.json has no entry for it. Every claimed server ` +
          `needs a runtime count, or the claim is unlocked.`,
      );
      continue;
    }
    if (expected !== claim.count) {
      errors.push(
        `README quotes ${claim.count} tests for \`servers/${claim.server}/\` ` +
          `but tools/test-counts.json records ${expected}. The claim is the ` +
          `number that server's own test command prints; update the README's ` +
          `"${claim.line.trim()}" line, or re-measure and update the counts file.`,
      );
    }
    // The floor. A `test-counts.json` edited down to match a stale README
    // would satisfy the equality above and nothing else, so compare it to
    // something derived from the source: every `it(` / `def test_` yields at
    // least one case, so the static count can never exceed the runtime one.
    const counted = countTestsInServer(serverPath);
    if (counted.total > expected) {
      errors.push(
        `tools/test-counts.json records ${expected} runtime cases for ` +
          `\`servers/${claim.server}/\`, but ${counted.total} test ` +
          `functions were counted statically across ${counted.files} file(s). ` +
          `A runtime count below the static count is impossible — the counts ` +
          `file is stale or was edited to match the README.`,
      );
    }
  }

  // Per-server README claims (#161, #166). The root README was locked and the
  // five server READMEs were not, so a claim there could drift indefinitely —
  // and one had, by more than 4x. Same unit, same source of truth.
  let serverClaimCount = 0;
  for (const server of [...serverDirs].sort()) {
    const readmePath = path.join(SERVERS_DIR, server, "README.md");
    if (!existsSync(readmePath)) continue;
    const claims = serverReadmeTestCountClaims(readFileSync(readmePath, "utf-8"));
    serverClaimCount += claims.length;
    const expected = runtimeCounts[server];
    for (const claim of claims) {
      if (expected === undefined) {
        errors.push(
          `servers/${server}/README.md quotes ${claim.count} tests but ` +
            `tools/test-counts.json has no entry for that server.`,
        );
        continue;
      }
      if (claim.count !== expected) {
        errors.push(
          `servers/${server}/README.md quotes ${claim.count} tests but ` +
            `tools/test-counts.json records ${expected}. The claim is the ` +
            `number the command on that line prints. Line: "${claim.line.trim()}"`,
        );
      }
    }
  }
  // Anti-vacuous floor. The parser above matches a shell comment, so a reword
  // that stops matching would make this whole section silently check nothing —
  // which is exactly the state that let a 4x-wrong claim sit unnoticed. Two
  // servers carry a claim today; if one is deliberately removed, lower this
  // and say why rather than letting the check quietly become a no-op.
  if (serverClaimCount < 2) {
    errors.push(
      `only ${serverClaimCount} per-server README test-count claim(s) were ` +
        `discovered; at least 2 are expected. Either a claim was removed ` +
        `(lower the floor deliberately) or the parser stopped matching.`,
    );
  }

  // Decision-range upper-bound check (#38). The README's architecture-
  // section summary cites a range like `D-002…D-N`; the upper bound
  // must equal the highest active D-NNN in MEMORY/core_decisions_ai.md.
  // Same drift class that `check-architecture-doc.mjs` catches inside
  // `docs/architecture.md`, but for the README's range citation.
  if (existsSync(DECISIONS_PATH)) {
    const decisions = readFileSync(DECISIONS_PATH, "utf-8");
    const latest = maxActiveDecisionId(decisions);
    const cited = readmeDecisionRangeBound(readme);
    if (latest > 0) {
      if (cited === null) {
        errors.push(
          "README must cite the active-decision range as `D-002…D-NNN` " +
            "somewhere (architecture-section summary by convention). Not found.",
        );
      } else if (cited !== latest) {
        errors.push(
          `README cites decision range up to D-${String(cited).padStart(3, "0")}, ` +
            `but the highest active D-NNN in MEMORY/core_decisions_ai.md is ` +
            `D-${String(latest).padStart(3, "0")}. Update the README's ` +
            `architecture-section summary to D-002…D-${String(latest).padStart(3, "0")}.`,
        );
      }
    }
  }

  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`error: ${e}\n`);
    return 1;
  }

  process.stdout.write(
    `README check ok: ${refs.length} server references, ${claims.length} root ` +
      `test-count claims, ${serverClaimCount} per-server claim(s), ` +
      `${serverDirs.size} server directories.\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(main());
}
