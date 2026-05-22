#!/usr/bin/env node
//
// Smoke check for `tools/capture_demo.sh` (issue #16).
//
// The capture script is the deterministic driver for the 60-second README
// demo: each of three surfaces exercises a load-bearing security primitive
// from one of the cookbook's shipped servers (D-004, D-005/D-006, D-007).
// JT records the GIF/video while it runs; CI runs this checker with
// `CAPTURE_PACE_SECONDS=0` so the demo can't bitrot the same way the
// existing `tools/check-readme.mjs`, `tools/check-spec-version.mjs`, and
// `tools/check-architecture-doc.mjs` lock the README and architecture doc.
//
// Contract this checker pins:
//
//   1. The script exits 0 on a fresh clone with no DB, no network, no
//      real GITHUB_TOKEN — only the per-server `node_modules/` and the
//      filesystem-sandbox-py package installed.
//   2. Each of the three surfaces actually runs (its banner header and
//      its distinctive output lines appear).
//   3. Surface 1's SQL guard rejected its three guard-violating queries
//      with named reasons, and allowed its three reads.
//   4. Surface 2's sandbox reported "outside_allowlist" for the traversal,
//      symlink, and absolute-outside cases, and a typed reason for the
//      relative/null-byte/control-char cases.
//   5. Surface 3 reported the per-file truncation cap fired AND the token
//      sentinel literal does not appear anywhere in stdout (the D-007
//      contract: token is on the wire, never in error context).
//
// Exit codes:
//   0 — all contract clauses hold
//   1 — drift detected (specific assertion failure printed)
//   2 — script not found / cannot be executed
//
// Pure helpers (REQUIRED_PATTERNS, FORBIDDEN_LITERALS, assertCaptureOutput,
// runCaptureDemo) are exported so `check-capture-demo.test.mjs` can drive
// the assertion logic against synthetic input.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const SCRIPT = path.join(REPO_ROOT, "tools/capture_demo.sh");

/**
 * Token sentinel hard-pinned in `tools/capture_demo.sh`'s surface 3.
 *
 * Reasserted here (not imported from the script) so a future edit that
 * silently changes the sentinel literal still leaves CI failing loudly
 * — the assertion only passes when the script's literal matches this
 * constant.
 */
export const TOKEN_SENTINEL = "ghp_REDACTION_SENTINEL_xxxxxxxxxxxxxxxxxxx";

/**
 * Patterns every successful capture run must surface, grouped by surface.
 * Order within a group is the order the script prints them.
 *
 * Patterns are matched as substrings (case-sensitive). They're chosen to
 * be specific enough that a refactor that changes a banner can't quietly
 * mask a surface that stopped running.
 */
export const REQUIRED_PATTERNS = [
  // Header
  "═══ mcp-server-cookbook · 60-second demo",

  // Surface 1
  "═══ 1/3 · postgres-readonly · SQL guard (D-004",
  "[OK] allow",                                                  // at least one allowed read row
  "leading keyword INSERT not in allowed set",                   // INSERT rejected with named reason
  "leading keyword DROP not in allowed set",                     // DROP   rejected with named reason
  "multi-statement input rejected (got 2 statements)",           // SELECT 1; DELETE FROM users
  "leading keyword UPDATE not in allowed set",                   // UPDATE /* sneaky */ ...

  // Surface 2
  "═══ 2/3 · filesystem-sandbox-py · path resolution (D-005, D-006)",
  "[OK]      inside path",                                       // inside resolved
  "reason='outside_allowlist'",                                  // at least one outside_allowlist escape
  "reason='input_relative_disallowed'",                          // relative case
  "reason='input_null_byte'",                                    // null-byte case
  "reason='input_control_char'",                                 // control-char case

  // Surface 3
  "═══ 3/3 · github-gists · token redaction at error boundaries (D-007)",
  "[OK] getGist success",
  "truncated=true",                                              // per-file cap fired on huge.json
  "truncated=false",                                             // per-file cap NOT fired on small.md
  "[OK] getGist 401 error path",
  "github_api_error (401 GET /gists/",                           // GithubApiError shape
  "token literal present in error.message?      false",          // D-007 explicit
  "token literal present in serialized error?   false",          // D-007 explicit

  // Closing banner
  "═══ demo complete",
];

/**
 * Literals that must NOT appear in stdout under any circumstance. The
 * token sentinel is the load-bearing D-007 check: if any future edit
 * accidentally surfaces the bearer through an error path, the literal
 * shows up here and we fail.
 */
export const FORBIDDEN_LITERALS = [TOKEN_SENTINEL];

/**
 * Assertion failure raised by `assertCaptureOutput`. Carries the offending
 * pattern/literal so the CLI runner can print a precise diagnosis.
 */
export class CaptureDemoAssertionError extends Error {
  constructor(message, { kind, pattern }) {
    super(message);
    this.name = "CaptureDemoAssertionError";
    this.kind = kind; // "missing-required" | "forbidden-present"
    this.pattern = pattern;
  }
}

/**
 * Verify `stdout` against the contract. Throws `CaptureDemoAssertionError`
 * on the first violation. Pure — no IO.
 */
export function assertCaptureOutput(stdout) {
  for (const pat of REQUIRED_PATTERNS) {
    if (!stdout.includes(pat)) {
      throw new CaptureDemoAssertionError(
        `missing required line: ${JSON.stringify(pat)}`,
        { kind: "missing-required", pattern: pat },
      );
    }
  }
  for (const literal of FORBIDDEN_LITERALS) {
    if (stdout.includes(literal)) {
      throw new CaptureDemoAssertionError(
        `forbidden literal present (D-007 contract violation): ${JSON.stringify(literal)}`,
        { kind: "forbidden-present", pattern: literal },
      );
    }
  }
}

/**
 * Run `tools/capture_demo.sh` with `CAPTURE_PACE_SECONDS=0` and return the
 * captured stdout + exit status. Synchronous (uses `spawnSync`) so the
 * CLI exit code path is straightforward and the unit tests can reason
 * about it.
 *
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runCaptureDemo(opts = {}) {
  if (!existsSync(SCRIPT)) {
    return {
      status: 2,
      stdout: "",
      stderr: `missing ${SCRIPT}`,
    };
  }
  const env = {
    ...process.env,
    ...(opts.env ?? {}),
    CAPTURE_PACE_SECONDS: "0",
  };
  const res = spawnSync("bash", [SCRIPT], {
    cwd: opts.cwd ?? REPO_ROOT,
    env,
    encoding: "utf8",
    // Generous buffer cap: surface 1 + 3 print sub-100KB each, surface 2
    // prints a handful of lines. 4 MiB is comfortable.
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function main() {
  const { status, stdout, stderr } = runCaptureDemo();
  if (status !== 0) {
    process.stderr.write(
      `capture_demo.sh exited with status ${status}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
    );
    process.exit(status === 2 ? 2 : 1);
  }
  try {
    assertCaptureOutput(stdout);
  } catch (err) {
    if (err instanceof CaptureDemoAssertionError) {
      process.stderr.write(
        `capture-demo contract violation: ${err.message}\n` +
          `--- captured stdout ---\n${stdout}\n`,
      );
      process.exit(1);
    }
    throw err;
  }
  process.stdout.write(
    `check ok: ${REQUIRED_PATTERNS.length} required patterns present, ` +
      `${FORBIDDEN_LITERALS.length} forbidden literals absent\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
