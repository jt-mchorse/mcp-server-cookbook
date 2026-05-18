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

1. **Read-only data access** to a stateful system (this PR — Postgres).
2. **Sandboxed filesystem access** with an explicit allow-list.
3. **API wrapper with auth** for a SaaS tool integration.
4. **Internal-tools bridge** wrapping a small custom CLI.

Each subdirectory's README leads with the threat model — what the server is
defending against, what it isn't, and where the operator's responsibility
starts. Every defensive measure is visible in code (no security-through-
obscurity), and every server uses defense in depth (no single point of
failure).

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the cross-server
layout and the shared conventions. Per-server design and threat model
live next to the server itself.

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

Test suites are hermetic (no Docker / no network needed):

```bash
cd servers/postgres-readonly      && npm install && npm test    # 38 SQL-guard tests
cd servers/filesystem-sandbox     && npm install && npm test    # 38 sandbox + tool + config tests
cd servers/github-gists           && npm install && npm test    # 28 config + client (redaction) + tool tests
cd servers/internal-tools-bridge  && npm install && npm test    # 20 bridge + tool tests (no shell, env scrub, output cap)
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

60-second demo pending until at least two servers are wired up so the
demo shows a *pattern* (read-only Postgres + filesystem sandbox), not a
single one-off.

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
