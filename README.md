# mcp-server-cookbook
> Four production-pattern MCP servers — Postgres read-only, filesystem sandbox, API-with-auth, internal-tools bridge — each with explicit security notes and example clients. Local-first; aligned to current MCP spec.

![CI](https://github.com/jt-mchorse/mcp-server-cookbook/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## What this is

A cookbook of small, opinionated MCP server implementations. Each lives in
its own subdirectory (`servers/<name>/`) with its own `package.json`,
README, threat model, and tests, so each is independently installable and
independently grep-able. Servers don't share runtime code — they're
patterns, not a framework.

The point isn't to wrap every possible API with an MCP server. It's to
demonstrate four distinct patterns of *agent ↔ external system* mediation
that come up in real LLM applications, with the security work done
visibly:

1. **Read-only data access** to a stateful system — `postgres-readonly`.
2. **Sandboxed filesystem access** with an explicit allow-list — `filesystem-sandbox` (TS) + `filesystem-sandbox-py` (Python parity).
3. **API wrapper with auth** for a SaaS tool integration — `github-gists`.
4. **Internal-tools bridge** wrapping a small custom CLI — `internal-tools-bridge`.

Each subdirectory's README leads with the threat model — what the server is
defending against, what it isn't, and where the operator's responsibility
starts. Every defensive measure is visible in code (no security-through-
obscurity), and every server uses defense in depth (no single point of
failure).

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the cross-server
layout, the shared conventions, and the design decisions behind each
one (D-002…D-009). Per-server design and threat model live next to the
server itself.

## Quickstart

Each server is independently runnable.

**`postgres-readonly`** — read-only Postgres MCP server with three tools
(`describe_schema`, `run_select`, `sample_rows`) and a defense-in-depth
SQL guard. Brings up a sample DB via Docker compose:

```bash
cd servers/postgres-readonly
docker compose up -d                                     # sample DB on :5433
npm install && npm run build
DATABASE_URL=postgresql://mcp_reader:mcp_reader@localhost:5433/bench npm start
```

**`filesystem-sandbox`** — filesystem MCP server with three tools
(`list_directory`, `read_file`, `write_file`) constrained to an
operator-defined allow-list. Symlink-safe, path-traversal-rejecting,
mandatory allow-list at boot. No external setup:

```bash
cd servers/filesystem-sandbox
npm install && npm run build
MCP_FS_SANDBOX_ALLOWLIST=/tmp/scratch:/tmp/uploads npm start
```

**`github-gists`** — SaaS-API-wrapper MCP server with two tools
(`get_gist`, `update_gist_file`) over the GitHub Gists REST API. Token
auth via `GITHUB_TOKEN`; redaction at error boundaries so the bearer
value never appears in tool results, error messages, or logs. Demonstrates
the cookbook's auth-token pattern. No external setup beyond the token:

```bash
cd servers/github-gists
npm install && npm run build
GITHUB_TOKEN=ghp_yourTokenWithGistScope npm start
```

API error responses follow the contract `github_api_error (<status> <endpoint>): <reason> | request-id=<X-GitHub-Request-Id> rate-limit-remaining=<n> rate-limit-reset=<unix-epoch> retry-after-seconds=<n>` — non-null diagnostic fields are appended in that order; missing headers are omitted (no `field=null` noise), so a non-GitHub-API path or a 5xx with headers stripped renders the unchanged base message.

**`internal-tools-bridge`** — wraps an in-repo CLI as a structured-args
MCP tool. The bundled CLI is `bin/repo-stats.mjs` (dep-free Node;
returns file counts by extension and total bytes for a directory).
The interesting code is `src/bridge.ts`: a `child_process.spawn` helper
that is shell-free (`shell: false`, array argv), runs only allow-listed
binaries, scrubs env to a documented passlist, caps stdout/stderr at
1 MiB, and SIGKILLs on a 10-second timeout. Demonstrates the
cookbook's internal-CLI-as-MCP-tool pattern. No external setup:

```bash
cd servers/internal-tools-bridge
npm install && npm run build
npm start
```

**`filesystem-sandbox-py`** — Python parity port of `filesystem-sandbox`
(#5). Same threat model, same tools, same security primitive, exposed
via the official `mcp` Python SDK. The security primitive is itself
dep-free — the MCP SDK is needed only to run the server, not to
exercise the tests:

```bash
cd servers/filesystem-sandbox-py
python -m venv .venv && . .venv/bin/activate
pip install -e '.[server]'
MCP_FS_SANDBOX_ALLOWLIST=/tmp/scratch mcp-filesystem-sandbox-py
```

Test suites are hermetic (no Docker / no network needed):

```bash
cd servers/postgres-readonly      && npm install && npm test    # 41 SQL-guard + public-surface tests
cd servers/filesystem-sandbox     && npm install && npm test    # 49 sandbox + tool + config + public-surface + atomic-write tests
cd servers/github-gists           && npm install && npm test    # 43 config + client (redaction + rate-limit diag + cfg validation) + error-message-format + tool + public-surface tests
cd servers/internal-tools-bridge  && npm install && npm test    # 32 bridge + tool + public-surface tests (no shell, env scrub, output cap, validateConfig)
cd servers/filesystem-sandbox-py  && pip install -e '.[dev]' && pytest  # 60 sandbox + tool + config + public-surface tests
```

Wiring into Claude Desktop, the Claude Code CLI, or your own MCP client is
documented in each server's README, alongside the threat model.

### Spec alignment

The MCP spec revision and the pinned `@modelcontextprotocol/sdk`
version every server agrees on are declared in
[`docs/spec-version.md`](docs/spec-version.md). The `spec-version`
CI job runs `tools/check-spec-version.mjs` on every PR and fails if
any server's `package.json` drifts from the doc, or if the servers
disagree among themselves. The bump procedure is in the same doc
(read the SDK release notes, update doc + every server in one PR).

## Benchmarks / Results

This repo doesn't carry benchmark numbers — its quality bar is "the threat
model is honest and the tests prove it." See each server's README for the
threat model and the test suite that exercises it.

## Demo

Today the live "demo" is a per-server `npm start` (Python parity uses
`mcp-filesystem-sandbox-py`) against the documented client wiring —
every server brings up locally in under a minute on a fresh clone, no
account setup. Each server's README leads with the threat model and
copy-pasteable client wiring (Claude Desktop, Claude Code CLI, or your
own MCP client).

A captured 60-second walkthrough (GIF or video) is **pending** — tracked
in [#16](https://github.com/jt-mchorse/mcp-server-cookbook/issues/16). The
intended path: bring up `postgres-readonly` + `filesystem-sandbox` (or
its Python parity) + `github-gists` against a single MCP client, exercise
one tool per server, and capture the trace.

`tools/capture-demo.mjs` makes the inputs to that recording reproducible:
it fingerprints the postgres seed, writes a deterministic allow-list
layout for the sandbox, and surfaces the public fixture gist ID
documented in [`docs/demo_fixture.md`](docs/demo_fixture.md). Re-run it
on every re-capture so the operator's screen recorder sees identical
arguments and results across takes.

## Why these decisions

See [`MEMORY/core_decisions_human.md`](MEMORY/core_decisions_human.md). Notable:

- **D-002.** Each server is a self-contained subdirectory with its own
  `package.json`, README, and tests. No shared runtime code. Cookbook over
  framework.
- **D-003.** Every server's README leads with an explicit threat model.
  Security notes are mandatory, not optional.
- **D-004.** `postgres-readonly` enforces default-deny on writes via
  *both* a read-only DB role and server-side SQL parsing. Defense in depth.
- **D-007.** Token-bearing servers (`github-gists` and any future
  cookbook entry that holds a credential) redact auth at error
  boundaries: the bearer value never appears in error messages, tool
  results, or logs, and the request body is dropped from error context
  so user-supplied content can't leak through that path either.
- **D-009.** The `internal-tools-bridge` server invokes its bundled
  CLI via `child_process.spawn` with `shell: false`, an explicit
  binary allow-list, an env passlist (`PATH`, `LANG`, `LC_ALL`, `TZ`,
  `NODE_OPTIONS` only), a 1 MiB per-stream output cap, and a per-call
  timeout — every layer enforced by regression tests. The MCP tool's
  input is structured args, never a raw command string.

## License

MIT
