#!/usr/bin/env node
//
// Verify the top-level README's claims about the servers match reality.
//
// Two invariants:
//   1. Server-dir references: every `servers/<name>/` referenced in README.md
//      points to an existing directory.
//   2. Per-server test-count quotes: every line in the Quickstart's "Test
//      suites are hermetic" block that quotes a number of tests for a
//      named server matches the static count of test cases (`it(`, `test(`
//      for vitest, `def test_` for pytest) in that server's test files.
//
// Both invariants are static: this script reads files, doesn't run them.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const README_PATH = path.join(REPO_ROOT, "README.md");
const SERVERS_DIR = path.join(REPO_ROOT, "servers");
const DECISIONS_PATH = path.join(REPO_ROOT, "MEMORY/core_decisions_ai.md");

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
    // Tolerant of extra commands before the `#`.
    const m = line.match(
      /^cd servers\/([a-z0-9][a-z0-9-]*[a-z0-9])\b.*#\s*(\d+)\s+[^#]*$/,
    );
    if (!m) continue;
    out.push({ server: m[1], count: Number(m[2]), line });
  }
  return out;
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
 * Count test cases in a single file. Strategy:
 *   - .ts / .tsx / .js / .mjs → count `it(`, `it.skip(`, `it.only(`,
 *     `test(`, `test.skip(`, `test.only(`, with `.each(...)` chains — only at
 *     column boundaries (preceded by whitespace, `(`, `;`, `{`, or
 *     start-of-line) to avoid matching identifiers that happen to contain
 *     `test`.
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
    const line = raw.trim();
    if (line.startsWith("//")) continue;
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

  const errors = [];

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
    const counted = countTestsInServer(serverPath);
    if (counted.total !== claim.count) {
      errors.push(
        `README quotes ${claim.count} tests for \`servers/${claim.server}/\` ` +
          `but ${counted.total} were found in ${counted.files} test file(s). ` +
          `Update the README's "${claim.line.trim()}" line or audit the server's tests.`,
      );
    }
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
    `README check ok: ${refs.length} server references, ${claims.length} test-count claims, ${serverDirs.size} server directories.\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
