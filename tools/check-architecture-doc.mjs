#!/usr/bin/env node
//
// Verify docs/architecture.md's claims about the servers match reality.
//
// Three invariants — parallel to the README checker but for the docs/
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

  console.log(
    `docs/architecture.md check ok: ${refs.length} server references, ` +
      `${dirs.length} server directories, ${STALE_PHRASES.length} stale phrases banned.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
