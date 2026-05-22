#!/usr/bin/env bash
# Deterministic driver for the 60-second cookbook demo (issue #16).
#
# Runs the three highest-leverage surfaces in sequence on a fresh clone
# with no DB, no network, and no real `GITHUB_TOKEN`. Each surface
# exercises the load-bearing security primitive of the corresponding
# shipped server — the part the threat model rests on, not just any
# happy-path tool call:
#
#   1. postgres-readonly · SQL guard layer (D-004)
#        guardQuery() against allowed selects, allowed CTEs, EXPLAIN,
#        and against writes, multi-statement, and admin keywords.
#        No DB required; this is the layer that exists precisely so
#        the guard refuses an attempted write before the DB role's
#        read-only check even runs.
#
#   2. filesystem-sandbox-py · path-resolution (D-005, D-006)
#        Sandbox.create([tmp_allowlist]) then resolve() on an inside
#        path (succeeds), then on a traversal, an absolute outside
#        path, a symlink whose target is outside, a relative path,
#        a null-byte injection, and a control-char injection. Every
#        rejection surfaces a typed SandboxEscape reason. Real disk
#        IO under a tempdir — symlink follow is the actual D-006
#        contract being exercised.
#
#   3. github-gists · token redaction at error boundaries (D-007)
#        Inject a fake fetch returning a fixture gist payload to
#        show projectGist's per-file cap + truncation behavior, then
#        a 401 error path with a recognizable token sentinel as the
#        configured bearer. The script prints GithubApiError's
#        message + serialized form and asserts the sentinel literal
#        is absent from both — that's the D-007 contract: the token
#        is on the wire (header), never in the error context.
#
# The script's stdout is what JT records while capturing the GIF/video.
# `tools/check-capture-demo.test.mjs` runs the script with
# `CAPTURE_PACE_SECONDS=0` in CI so the demo can't bitrot.
#
# Variables:
#   CAPTURE_PACE_SECONDS  pause between sections (default 2 for
#                         recording; the smoke test sets it to 0).
#
# Exit: 0 on full success; non-zero on any sub-step failure.
# Requires:
#   - Node 20+ (for `npx`-style invocations via per-server node_modules/.bin/tsx)
#   - Python 3.11+ with filesystem-sandbox-py installed (`pip install -e .` in
#     `servers/filesystem-sandbox-py`, or a venv at `.venv/`)
#   - `npm ci` already run in `servers/postgres-readonly` and
#     `servers/github-gists` (the smoke test job does this)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACE="${CAPTURE_PACE_SECONDS:-2}"

banner() {
  printf '\n'
  printf '═══ %s\n' "$1"
  printf '\n'
}

pace() {
  if [ "$PACE" != "0" ]; then
    sleep "$PACE"
  fi
}

cd "$REPO_ROOT"

banner "mcp-server-cookbook · 60-second demo"
printf 'three surfaces · each exercises a load-bearing security primitive · no DB, no network, no real token\n'
pace

# ───────────────────────────────────────────────────────────────────────────
# Surface 1 — postgres-readonly · SQL guard (D-004)
# ───────────────────────────────────────────────────────────────────────────

banner "1/3 · postgres-readonly · SQL guard (D-004 layered defense)"
printf 'guardQuery() against allowed reads and rejected writes / admin / multi-statement input.\n'
printf 'no DB required — this is the layer that refuses an attempted write\n'
printf 'before the DB role`s read-only check even runs.\n\n'

PG_TSX="$REPO_ROOT/servers/postgres-readonly/node_modules/.bin/tsx"
if [ ! -x "$PG_TSX" ]; then
  printf 'ERROR: missing %s — run `npm ci` in servers/postgres-readonly first\n' "$PG_TSX" >&2
  exit 2
fi
( cd "$REPO_ROOT/servers/postgres-readonly" && "$PG_TSX" -e '
import { guardQuery } from "./src/sqlGuard.ts";

const cases: Array<[string, "allow" | "reject"]> = [
  ["SELECT 1",                                  "allow"],
  ["WITH a AS (SELECT 1) SELECT * FROM a",       "allow"],
  ["EXPLAIN SELECT * FROM users",                "allow"],
  ["INSERT INTO users(id) VALUES (1)",           "reject"],
  ["DROP TABLE users",                           "reject"],
  ["SELECT 1; DELETE FROM users",                "reject"],
  ["UPDATE /* sneaky */ users SET name = ?",     "reject"],
];

let failed = 0;
for (const [q, expected] of cases) {
  const r = guardQuery(q);
  const got: "allow" | "reject" = r.ok ? "allow" : "reject";
  const ok = got === expected;
  if (!ok) failed++;
  const tag = ok ? "OK" : "FAIL";
  const status = expected === "allow" ? "allow " : "reject";
  const reason = r.ok ? "" : `reason="${r.reason}"`;
  console.log(`[${tag}] ${status}  ${reason.padEnd(80)} :: ${q}`);
}
if (failed > 0) {
  console.error(`SQL-guard demo failed: ${failed} unexpected outcome(s)`);
  process.exit(1);
}
' )
pace

# ───────────────────────────────────────────────────────────────────────────
# Surface 2 — filesystem-sandbox-py · path resolution (D-005, D-006)
# ───────────────────────────────────────────────────────────────────────────

banner "2/3 · filesystem-sandbox-py · path resolution (D-005, D-006)"
printf 'Sandbox.create([tmp_allowlist]) then resolve() on inside / traversal / absolute-outside /\n'
printf 'symlink-outside / relative / null-byte / control-char inputs.\n'
printf 'real disk IO under a tempdir; every rejection carries a typed SandboxEscape reason.\n\n'

# Pick a python that has filesystem_sandbox importable. Order of preference:
#   1) the server's own venv if present (.venv/bin/python3)
#   2) `python3` on PATH (CI / dev shells)
# In CI we pip install -e . before running this script, so plain python3 works.
PY_SANDBOX="$REPO_ROOT/servers/filesystem-sandbox-py/.venv/bin/python3"
if [ ! -x "$PY_SANDBOX" ]; then
  PY_SANDBOX="$(command -v python3 || true)"
fi
if [ -z "$PY_SANDBOX" ]; then
  printf 'ERROR: no python3 found\n' >&2
  exit 2
fi
"$PY_SANDBOX" - <<'PY'
import os
import shutil
import sys
import tempfile

from filesystem_sandbox import Sandbox, SandboxEscape

# Fresh tempdir per run so the demo doesn't depend on any global filesystem
# state. Symlink target points outside the allowlist — the D-006 case.
with tempfile.TemporaryDirectory(prefix="mcp_cookbook_demo_") as tmp_root:
    inside_path = os.path.join(tmp_root, "hello.txt")
    with open(inside_path, "w") as f:
        f.write("hello from inside the allowlist\n")
    symlink_path = os.path.join(tmp_root, "passwd_link")
    os.symlink("/etc/passwd", symlink_path)

    sb = Sandbox.create([tmp_root])
    print(f"  allowlist root: {sb.allowed_roots[0]}")
    print()

    cases = [
        ("inside path",         os.path.join(tmp_root, "hello.txt")),
        ("traversal",           os.path.join(tmp_root, "../etc/passwd")),
        ("absolute outside",    "/etc/passwd"),
        ("symlink -> outside",  os.path.join(tmp_root, "passwd_link")),
        ("relative",            "hello.txt"),
        ("null byte",           os.path.join(tmp_root, "hello\x00.txt")),
        ("control char",        os.path.join(tmp_root, "hello\nworld.txt")),
    ]
    failed = 0
    for label, path in cases:
        try:
            resolved = sb.resolve(path)
            print(f"[OK]      {label:22s}  ->  resolved={resolved.resolved!r}")
        except SandboxEscape as e:
            print(f"[ESCAPE]  {label:22s}  ->  reason={e.reason!r}")
    # Expectation pin: the "inside path" case must succeed; everything else
    # must escape. Pin in the script so a future refactor that quietly
    # widens the sandbox fails the demo loudly.
    expected_outcomes = {
        "inside path": "ok",
        "traversal": "escape",
        "absolute outside": "escape",
        "symlink -> outside": "escape",
        "relative": "escape",
        "null byte": "escape",
        "control char": "escape",
    }
    for label, path in cases:
        try:
            sb.resolve(path)
            got = "ok"
        except SandboxEscape:
            got = "escape"
        if got != expected_outcomes[label]:
            print(f"FAIL: sandbox demo expected {label!r}={expected_outcomes[label]!r}, got {got!r}", file=sys.stderr)
            failed += 1
    if failed > 0:
        sys.exit(1)
PY
pace

# ───────────────────────────────────────────────────────────────────────────
# Surface 3 — github-gists · token redaction at error boundaries (D-007)
# ───────────────────────────────────────────────────────────────────────────

banner "3/3 · github-gists · token redaction at error boundaries (D-007)"
printf 'inject a fake fetch · fixture gist with truncation, then a 401 with a recognizable token sentinel.\n'
printf 'asserts the sentinel is absent from GithubApiError.message and from its serialized form.\n\n'

GH_TSX="$REPO_ROOT/servers/github-gists/node_modules/.bin/tsx"
if [ ! -x "$GH_TSX" ]; then
  printf 'ERROR: missing %s — run `npm ci` in servers/github-gists first\n' "$GH_TSX" >&2
  exit 2
fi
( cd "$REPO_ROOT/servers/github-gists" && "$GH_TSX" -e '
import { GistsClient, GithubApiError, type FetchLike } from "./src/client.ts";
import { projectGist } from "./src/tools.ts";

// Recognizable literal so any leak shows up grep-ably in CI logs.
const TOKEN_SENTINEL = "ghp_REDACTION_SENTINEL_xxxxxxxxxxxxxxxxxxx";

async function main() {
  // --- (a) successful getGist + per-file truncation cap ---
  const bigContent = "x".repeat(150_000);
  const fakeFetchOk: FetchLike = async (_url, init) => {
    const sentAuth = init?.headers?.Authorization ?? "";
    if (!sentAuth.includes(TOKEN_SENTINEL)) {
      throw new Error("expected token to be on Authorization header (the D-007 contract: on the wire, never in errors)");
    }
    return {
      status: 200, ok: true,
      json: async () => ({
        id: "abc123def456",
        description: "demo gist",
        public: true,
        html_url: "https://gist.github.com/example/abc123def456",
        files: {
          "small.md":  { filename: "small.md",  language: "Markdown", size: 12,                content: "hello world\n" },
          "huge.json": { filename: "huge.json", language: "JSON",     size: bigContent.length, content: bigContent },
        },
      }),
      text: async () => "",
    };
  };
  const cfg = {
    token:     TOKEN_SENTINEL,
    baseUrl:   "https://api.github.com",
    userAgent: "mcp-cookbook-demo/0.1.0",
    timeoutMs: 5000,
  };
  const client = new GistsClient({ cfg, fetch: fakeFetchOk });
  const raw = await client.getGist("abc123def456");
  const projected = projectGist(raw, 100_000);
  console.log("[OK] getGist success");
  console.log("  description:", projected.description);
  console.log("  files:");
  for (const f of projected.files) {
    const sz = String(f.size).padStart(7);
    const ct = f.content === null ? "<null>" : f.content.slice(0, 40);
    console.log(`    ${f.filename.padEnd(12)}  size=${sz}  truncated=${f.truncated}  content=${ct}`);
  }
  console.log();

  // --- (b) error path: 401 with token sentinel configured ---
  const fakeFetchFail: FetchLike = async () => ({
    status: 401, ok: false,
    json: async () => ({ message: "Bad credentials" }),
    text: async () => "",
  });
  const client2 = new GistsClient({ cfg, fetch: fakeFetchFail });
  let caught: GithubApiError | null = null;
  try {
    await client2.getGist("abc123def456");
  } catch (e) {
    if (!(e instanceof GithubApiError)) throw e;
    caught = e;
  }
  if (caught === null) {
    console.error("FAIL: expected GithubApiError on 401");
    process.exit(1);
  }
  console.log("[OK] getGist 401 error path");
  console.log("  error.message:  ", caught.message);
  console.log("  error.status:   ", caught.status);
  console.log("  error.endpoint: ", caught.endpoint);
  console.log("  error.reason:   ", caught.reason);

  const ser = JSON.stringify({
    message:  caught.message,
    status:   caught.status,
    endpoint: caught.endpoint,
    reason:   caught.reason,
  });
  const inMessage    = caught.message.includes(TOKEN_SENTINEL);
  const inSerialized = ser.includes(TOKEN_SENTINEL);
  console.log("  token literal present in error.message?     ", inMessage);
  console.log("  token literal present in serialized error?  ", inSerialized);
  if (inMessage || inSerialized) {
    console.error("FAIL: D-007 contract broken — token leaked into error surface");
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
' )
pace

banner "demo complete"
printf 'all three surfaces ran end-to-end · zero DB, zero network, zero real credentials.\n'
printf 'recapture: tools/capture_demo.sh (env: CAPTURE_PACE_SECONDS).\n'
