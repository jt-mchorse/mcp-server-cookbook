#!/usr/bin/env node
//
// Verify docs/architecture.md's claims about the servers match reality.
//
// Five invariants — parallel to the README checker but for the docs/
// reference doc that lists shipped server directories:
//
//   1. Server-dir references resolve: every `servers/<name>/` token in
//      docs/architecture.md points to an existing directory under
//      `servers/`.
//   2. Every existing `servers/<name>/` directory is referenced at least
//      once in the doc. (So a future sixth server can't ship without
//      the architecture doc updating to mention it.)
//   3. None of the four stale-state phrases from issue #22 appear:
//      `api-with-auth` (old name for what shipped as `github-gists`),
//      `pending issue`, `pending (not yet filed)`, and `this PR`. Each
//      was a specific shape of the pre-#22 staleness; locking absence
//      means a future copy-paste from an old version can't silently
//      reintroduce the bug.
//   4. Active-decision coverage (#25): every non-superseded `D-NNN >=
//      MIN_ACTIVE_DECISION_ID` in `MEMORY/core_decisions_ai.md` must be
//      referenced at least once in `docs/architecture.md`. Mirrors the
//      portfolio-wide upper-bound axis shipped in `llm-eval-harness`
//      #32, `prompt-regression-suite` #27, `embedding-model-shootout`
//      #22, `vector-search-at-scale` #24, and earlier sisters.
//   5. Closed-feature-issue coverage (#25): every issue in
//      `KNOWN_SHIPPED_ISSUES` is referenced at least once. So if a
//      sixth server ships under #N, this lock fails until the
//      architecture doc grows a section that names it.
//
// Static-only: this script reads files, doesn't run them. Runs in CI on
// every PR alongside the `readme-check` job.
//
// Exit codes:
//   0 — all invariants hold
//   1 — drift detected
//   2 — bad input (missing doc, no servers/)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ARCH_PATH = path.join(REPO_ROOT, "docs/architecture.md");
const SERVERS_DIR = path.join(REPO_ROOT, "servers");
const DECISIONS_PATH = path.join(REPO_ROOT, "MEMORY/core_decisions_ai.md");

/**
 * Lower bound on which core decisions must be cited in architecture.md.
 * D-001 is the baseline "scope per handoff §2" entry every repo carries
 * and isn't load-bearing in the per-server text, so skip it; D-002 is
 * the first repo-specific decision and onward is in scope.
 *
 * Hard-pinned in the test file so this can't drift.
 */
export const MIN_ACTIVE_DECISION_ID = 2;

/**
 * Issue numbers whose feature work shipped and is reflected somewhere
 * in the architecture doc. A new entry here forces the doc to grow a
 * mention of that issue or its closure on the next CI run.
 *
 * Hard-pinned in the test file so this can't drift.
 */
export const KNOWN_SHIPPED_ISSUES = Object.freeze([1, 2, 3, 4, 5]);

/**
 * Collect every `servers/<name>/` substring from a markdown source and
 * return the unique sorted set of `<name>` values. Exported so the tests
 * can exercise it against synthetic input.
 */
export function archServerRefs(markdown) {
  const re = /servers\/([a-z0-9][a-z0-9-]*[a-z0-9])\b/g;
  const names = new Set();
  for (const m of markdown.matchAll(re)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * The set of phrases that must not appear in docs/architecture.md. Each
 * one is the load-bearing shape of an instance of the original #22 drift
 * (architecture doc claimed pending state for shipped servers and named
 * a never-shipped `api-with-auth` directory).
 *
 * Exported so the tests can iterate over the same list the checker uses.
 */
export const STALE_PHRASES = Object.freeze([
  "api-with-auth",
  "pending issue",
  "pending (not yet filed)",
  "this PR",
]);

/**
 * Locate stale phrases in a markdown source. Returns `[{phrase, index}]`
 * for each hit; empty array means clean.
 */
export function findStalePhrases(markdown) {
  const hits = [];
  for (const phrase of STALE_PHRASES) {
    const idx = markdown.indexOf(phrase);
    if (idx >= 0) hits.push({ phrase, index: idx });
  }
  return hits;
}

/**
 * Parse `MEMORY/core_decisions_ai.md` and return the sorted ascending
 * array of integer ids for active (non-superseded) entries with id
 * `>= MIN_ACTIVE_DECISION_ID`.
 *
 * The decisions file is YAML-ish but we do not import a YAML parser:
 * the file's regular shape (`- id: D-NNN` ... `superseded_by: X` per
 * block) is enough for a small regex, and the script must stay
 * dep-free so CI can run it without `npm install` (D-008's spirit —
 * the related check-spec-version script is also stdlib-only).
 *
 * Exported so tests can exercise it against synthetic decisions input.
 */
export function activeDecisions(decisionsMd) {
  // Split on lines that introduce a new entry. The leading `^` won't
  // work with a top-level entry that starts the file, so split on the
  // newline-anchored `- id:` form and treat each piece as one block.
  const blocks = decisionsMd.split(/\n(?=- id:)/);
  const out = [];
  for (const block of blocks) {
    const idMatch = block.match(/- id:\s*D-(\d+)/);
    if (!idMatch) continue;
    const supMatch = block.match(/superseded_by:\s*(\S+)/);
    const supValue = supMatch ? supMatch[1].trim().toLowerCase() : "null";
    const isActive = supValue === "null";
    if (!isActive) continue;
    const n = Number.parseInt(idMatch[1], 10);
    if (Number.isFinite(n) && n >= MIN_ACTIVE_DECISION_ID) out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Return the subset of `activeIds` that are not cited anywhere in
 * `archMd`. A citation is any `D-NNN` or `D-0*NNN` token bounded by
 * word boundaries, so "D-7", "D-07", and "D-007" all resolve to 7.
 *
 * Exported so tests can exercise it against synthetic input.
 */
export function findUnreferencedDecisions(archMd, activeIds) {
  const referenced = new Set();
  for (const m of archMd.matchAll(/\bD-0*(\d+)\b/g)) {
    referenced.add(Number.parseInt(m[1], 10));
  }
  return activeIds.filter((n) => !referenced.has(n));
}

/**
 * Return the subset of `KNOWN_SHIPPED_ISSUES` that aren't referenced
 * (as `#NN` or in a `(#NN)` annotation) in the architecture doc.
 *
 * Exported so tests can exercise it against synthetic input.
 */
export function findUnreferencedShippedIssues(archMd) {
  const referenced = new Set();
  for (const m of archMd.matchAll(/#(\d+)\b/g)) {
    referenced.add(Number.parseInt(m[1], 10));
  }
  return KNOWN_SHIPPED_ISSUES.filter((n) => !referenced.has(n));
}

/**
 * List immediate subdirectories of `servers/` — the set of shipped
 * server packages. Sorted for stable diffs.
 */
function listServerDirs() {
  return readdirSync(SERVERS_DIR)
    .filter((name) => {
      const p = path.join(SERVERS_DIR, name);
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function fail(msg) {
  console.error(`docs/architecture.md check failed:\n  ${msg}`);
  process.exit(1);
}

function badInput(msg) {
  console.error(`docs/architecture.md check could not run:\n  ${msg}`);
  process.exit(2);
}

function main() {
  if (!existsSync(ARCH_PATH)) {
    badInput(`docs/architecture.md not found at ${ARCH_PATH}`);
  }
  if (!existsSync(SERVERS_DIR)) {
    badInput(`servers/ directory not found at ${SERVERS_DIR}`);
  }

  const markdown = readFileSync(ARCH_PATH, "utf8");
  const refs = archServerRefs(markdown);
  const dirs = listServerDirs();
  if (dirs.length === 0) {
    badInput(`servers/ has no subdirectories; expected at least one`);
  }

  // Invariant 1: every `servers/<name>/` referenced in the doc resolves.
  const missing = refs.filter((name) => !existsSync(path.join(SERVERS_DIR, name)));
  if (missing.length > 0) {
    fail(
      `docs/architecture.md references server directories that don't exist: ` +
        `${JSON.stringify(missing)}. Either create the directory or remove the reference.`,
    );
  }

  // Invariant 2: every existing servers/<name>/ is referenced at least once.
  const unreferenced = dirs.filter((name) => !refs.includes(name));
  if (unreferenced.length > 0) {
    fail(
      `docs/architecture.md does not reference these shipped server directories: ` +
        `${JSON.stringify(unreferenced)}. The doc must enumerate every entry under ` +
        `servers/ — add a bullet in the Shipped entries section or the directory diagram.`,
    );
  }

  // Invariant 3: none of the four stale-state phrases appear.
  const stale = findStalePhrases(markdown);
  if (stale.length > 0) {
    const which = stale.map((h) => JSON.stringify(h.phrase)).join(", ");
    fail(
      `docs/architecture.md contains stale phrasing from before #22: ${which}. ` +
        `These specific shapes were the original drift — either rephrase to remove them ` +
        `or, if a phrase is now load-bearing in a different context, update STALE_PHRASES ` +
        `in tools/check-architecture-doc.mjs with a comment explaining why.`,
    );
  }

  // Invariant 4: every active D-NNN >= MIN_ACTIVE_DECISION_ID is cited.
  if (!existsSync(DECISIONS_PATH)) {
    badInput(`MEMORY/core_decisions_ai.md not found at ${DECISIONS_PATH}`);
  }
  const decisionsMd = readFileSync(DECISIONS_PATH, "utf8");
  const active = activeDecisions(decisionsMd);
  const unreferencedDecisions = findUnreferencedDecisions(markdown, active);
  if (unreferencedDecisions.length > 0) {
    const which = unreferencedDecisions.map((n) => `D-${String(n).padStart(3, "0")}`).join(", ");
    fail(
      `docs/architecture.md does not reference these active (non-superseded) ` +
        `core decisions: ${which}. Every D-NNN in MEMORY/core_decisions_ai.md ` +
        `should be cited in the architecture doc where the relevant code lives. ` +
        `If a decision is genuinely not load-bearing here, supersede it; the lock ` +
        `only honors active entries.`,
    );
  }

  // Invariant 5: every shipped feature-issue is referenced.
  const missingIssues = findUnreferencedShippedIssues(markdown);
  if (missingIssues.length > 0) {
    const which = missingIssues.map((n) => `#${n}`).join(", ");
    fail(
      `docs/architecture.md does not reference these shipped feature-issues: ` +
        `${which}. Every entry in KNOWN_SHIPPED_ISSUES should be annotated ` +
        `(typically in the directory diagram or the Shipped entries section). ` +
        `If an issue closed via a docs-only or memory-only PR and was never ` +
        `architectural, drop it from KNOWN_SHIPPED_ISSUES with a comment.`,
    );
  }

  console.log(
    `docs/architecture.md check ok: ${refs.length} server references, ` +
      `${dirs.length} server directories, ${STALE_PHRASES.length} stale phrases banned, ` +
      `${active.length} active decisions cited, ${KNOWN_SHIPPED_ISSUES.length} shipped issues cited.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
