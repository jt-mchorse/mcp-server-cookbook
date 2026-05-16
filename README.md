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

Test suites are hermetic (no Docker needed for the guard tests):

```bash
cd servers/postgres-readonly  && npm install && npm test    # 38 SQL-guard tests
cd servers/filesystem-sandbox && npm install && npm test    # 38 sandbox + tool + config tests
```

Wiring into Claude Desktop, the Claude Code CLI, or your own MCP client is
documented in each server's README, alongside the threat model.

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

## License

MIT
