# Architecture

The cookbook is a flat collection of independent MCP server packages. There
is **no shared runtime code** — each server can be installed and read
top-to-bottom in isolation. That's deliberate (D-002): a cookbook should
let a reader copy one entry without dragging in five sibling abstractions.

```
mcp-server-cookbook/
├── servers/
│   ├── postgres-readonly/        ← read-only DB (#1, D-004)
│   ├── filesystem-sandbox/       ← allow-listed FS, TS (#2, D-005/D-006)
│   ├── filesystem-sandbox-py/    ← Python parity of filesystem-sandbox (#5)
│   ├── github-gists/             ← SaaS-API wrapper with token redaction (#3, D-007)
│   └── internal-tools-bridge/    ← in-repo CLI as MCP tool (#4, D-009)
└── docs/
    ├── architecture.md           ← you are here
    └── spec-version.md           ← canonical MCP SDK pin (D-008)
```

Each server is its own npm workspace **without** an actual workspaces
declaration in a root `package.json`. Adding a workspaces root would couple
the servers' dep graphs (one server's TypeScript or Vitest version would
affect the others), which is the opposite of "cookbook". When/if a server
needs a sibling, that's an explicit cross-server import in its own
package.json — visible in code, not implicit through hoisting.

## Per-server invariants

Every server in `servers/<name>/` ships with this exact surface:

```
servers/<name>/
├── README.md                  ← starts with the threat model (D-003)
├── package.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── src/
│   └── server.ts              ← MCP entry point (stdio transport)
├── test/
│   └── *.test.ts              ← hermetic tests for security-critical code
└── (optional) docker-compose.yml + sample-db/ or sample-data/
```

The runtime contract:
- **stdio transport.** Local-first; no network listening.
- **One process, one server.** The MCP server lives for one client
  conversation.
- **Per-call isolation where possible.** Database clients, filesystem
  handles, etc. are opened per tool call so the blast radius of leaked
  state stays one statement.

## How `postgres-readonly` fits the pattern

```mermaid
flowchart LR
  CLIENT[MCP client<br/>e.g. Claude Desktop]
  SERVER[postgres-readonly<br/>stdio MCP server]
  GUARD[SQL guard<br/>src/sqlGuard.ts]
  DB[(Postgres<br/>read-only role)]

  CLIENT -- list_tools --> SERVER
  CLIENT -- call_tool: run_select --> SERVER
  SERVER --> GUARD
  GUARD -- pass --> DB
  GUARD -- reject --> SERVER
  DB -- rows or error --> SERVER
  SERVER -- result or isError --> CLIENT
```

Three defense layers (D-004):

1. **DB-side.** The connection string points at a role with no write
   privileges. Bundled `sample-db/init.sql` creates `mcp_reader` granted
   only `SELECT` on `public`.
2. **Session-side.** Each query runs inside a session with
   `default_transaction_read_only = on`, so the engine refuses writes
   even if the role were mis-configured.
3. **Statement-side.** Every input to `run_select` passes through
   [`src/sqlGuard.ts`](../servers/postgres-readonly/src/sqlGuard.ts),
   which strips comments + string literals, splits on `;` while
   honoring quoted strings, requires the leading keyword be in a small
   allow-list, and rejects any forbidden keyword (every write/DDL verb,
   `pg_terminate_backend`, `pg_sleep`, `SET`, `RESET`, `LISTEN`, etc.).

The `WITH x AS (INSERT INTO ... RETURNING ...) SELECT * FROM x` bypass —
where the leading keyword is a benign `WITH` — is caught by the
forbidden-keyword scan, which is why the scan exists despite the
allow-listed leading keyword. The `INSERT` substring inside a string
literal (e.g. `SELECT 'INSERT INTO' AS msg`) is allowed because the scan
runs against a string-literal-stripped copy of the statement, not the
raw input.

## What's deliberately not in the cookbook

- **A "framework" for building MCP servers.** Servers in this repo don't
  inherit from a base class or share a server-loader. If a future entry
  needs the same boilerplate, the boilerplate is copied — not abstracted
  — until at least four entries demand the same shape.
- **Hosted MCP / network-reachable transports.** Local stdio only. Hosted
  MCP introduces auth, rate limiting, multi-tenancy, and observability
  concerns that pull a cookbook into framework territory.
- **A "registry" of available servers discoverable at runtime.** Servers
  are wired into clients (Claude Desktop, Claude Code, etc.) by config,
  one at a time.

## Shipped entries

All four cookbook patterns ship today; the Python parity port of the
filesystem sandbox is a fifth directory exercising the same threat
model from a second language ecosystem.

- **`servers/postgres-readonly/`** — read-only data access to Postgres.
  Three tools (`describe_schema`, `run_select`, `sample_rows`),
  defense-in-depth SQL guard (D-004). Closes #1.
- **`servers/filesystem-sandbox/`** — allow-listed filesystem access
  (TS). Three tools (`list_directory`, `read_file`, `write_file`),
  construction-time allow-list resolution (D-005), `realpath`-based
  symlink dereferencing (D-006). Closes #2.
- **`servers/github-gists/`** — API-wrapper-with-auth pattern over the
  GitHub Gists REST API. Two tools (`get_gist`, `update_gist_file`),
  token redaction at error boundaries (D-007). Closes #3.
- **`servers/internal-tools-bridge/`** — in-repo CLI exposed as a
  structured-args MCP tool. Shell-free `spawn` with binary allow-list,
  env passlist, output cap, per-call timeout (D-009). Closes #4.
- **`servers/filesystem-sandbox-py/`** — Python parity port of
  `servers/filesystem-sandbox/` against the official `mcp` Python SDK.
  Same threat model, same primitive shape, dep-free security core.
  Closes #5.
