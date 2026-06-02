# postgres-readonly MCP server

A stdio-transport MCP server that exposes three safe-read tools against any
Postgres database reachable by `DATABASE_URL`.

## Tools

| Tool              | Input                                                | Output                                            |
|-------------------|------------------------------------------------------|---------------------------------------------------|
| `describe_schema` | `{ schema?: string }` (default `"public"`)           | Plain-text listing of tables, views, columns      |
| `run_select`      | `{ sql: string }` — single SELECT-shaped statement   | JSON: `{ row_count, truncated, fields, rows }`    |
| `sample_rows`     | `{ schema?, table, limit? }` (`limit` capped at 50)  | JSON: `{ row_count, fields, rows }`               |

`run_select` accepts statements whose top-level keyword is `SELECT`, `WITH`,
`VALUES`, `TABLE`, or `EXPLAIN` (without `ANALYZE`). Everything else is
rejected by [`src/sqlGuard.ts`](src/sqlGuard.ts).

## Threat model

This server is intended to be wired into an LLM agent that the operator
trusts to *read* but does not trust to *write*. The threats it defends
against, ranked by severity:

### 1. Data destruction or modification

The agent emits `DROP TABLE`, `DELETE`, `UPDATE`, `INSERT`, `TRUNCATE`,
`ALTER`, `GRANT`, `REVOKE`, etc.

**Defenses (D-004 — defense in depth):**
- **DB-side enforcement.** The connection string must point to a role with
  no write privileges. The bundled `sample-db/init.sql` creates an
  `mcp_reader` role that is granted only `SELECT` on schema `public` and
  has writes explicitly `REVOKE`d.
- **Server-side enforcement.** Every input to `run_select` passes through
  [`src/sqlGuard.ts`](src/sqlGuard.ts), which:
  - strips comments before any keyword check (an attacker can't hide writes
    inside a `--` or `/* */` comment),
  - splits on `;` while honoring single, double, and dollar-quoted strings
    (so `SELECT 'a;b'` doesn't get falsely split),
  - rejects multi-statement input outright,
  - requires the leading keyword be in a small allow-list,
  - rejects any input where any forbidden keyword (every write/DDL verb
    plus the dangerous functions and session-mutators below) appears as a
    whole word.
- **Session-side enforcement.** Each query is run inside a session that
  has `default_transaction_read_only = on` set, so even if both of the
  above were bypassed the engine would refuse.

### 2. Server denial-of-service via expensive queries

The agent emits `SELECT * FROM big_table CROSS JOIN big_table` or sleeps.

**Defenses:**
- `statement_timeout` is set per session (default 5s, configurable via
  `STATEMENT_TIMEOUT_MS`).
- `pg_sleep` is in the forbidden-keywords list.
- `MAX_ROWS` (default 1000) caps the result set returned to the client.
  Postgres still does the work, but the MCP transport doesn't carry the
  blowup.

### 3. Backend disruption

The agent emits `pg_terminate_backend(...)`, `pg_cancel_backend(...)`,
`pg_reload_conf(...)`, `LISTEN`, `pg_notify`, etc.

**Defenses:** every one is in the forbidden-keywords list.

### 4. Identifier injection via `sample_rows`

`sample_rows` interpolates `schema` and `table` into the SQL because
Postgres won't bind identifiers as parameters. We validate both against
`/^[A-Za-z_][A-Za-z0-9_]*$/` before any quoting; non-bare-identifier input
is rejected with a clear error.

### 5. Connection-level escapes

`SET ROLE`, `SET search_path`, `SET session_replication_role`, etc., would
let an agent change identity or alter constraint enforcement.

**Defenses:** `SET` and `RESET` are in the forbidden-keywords list, so
even a single isolated `SET` rejects.

## Out of scope

- **AuthN/Z of the MCP client.** Stdio transport assumes the client (a
  Claude Desktop or an agent process) is trusted to invoke the server at
  all. If you need network-reachable hosting with auth, that's a separate
  pattern (and a separate cookbook entry).
- **Audit logging.** The server logs operational errors to stderr. It does
  not write a structured audit log of accepted queries — that's the
  agent's trace concern (see `agent-orchestration-platform` issue #6).
- **Row-level security.** RLS is the right tool for "this agent should
  only see rows for tenant X." This server doesn't add that semantic; use
  Postgres RLS at the DB layer.

### Programmatic-entry config validation (#44)

`withClient(cfg, fn)` calls `validateDbConfig(cfg)` before opening any
connection or issuing SQL. The gate rejects empty `connectionString`,
non-positive `maxRows`, and non-positive `statementTimeoutMs`. The last
one is security-relevant: Postgres treats `statement_timeout = 0` as
**no timeout**, so a programmatic `0` would silently disable the
per-query timeout that the server documents as defense in depth.
Mirrors the `BridgeConfig` validation pattern in
[`servers/internal-tools-bridge/src/bridge.ts`](../internal-tools-bridge/src/bridge.ts)
(D-009) — same loud-failure-at-entry posture on a sibling `Config` type.

## Quickstart

**Sample DB (Docker):**

```bash
cd servers/postgres-readonly
docker compose up -d                 # brings up Postgres on :5433 with seed data + mcp_reader role
cp .env.example .env                 # uses mcp_reader credentials
npm install
npm run build
DATABASE_URL=postgresql://mcp_reader:mcp_reader@localhost:5433/bench npm start
```

**Tests (no DB needed for the guard suite):**

```bash
npm test                             # runs vitest; sqlGuard tests are hermetic
```

**Wiring into Claude Desktop** (path-substitute `$HOME/path/to/...`):

```json
{
  "mcpServers": {
    "postgres-readonly": {
      "command": "node",
      "args": ["$HOME/path/to/mcp-server-cookbook/servers/postgres-readonly/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://mcp_reader:mcp_reader@localhost:5433/bench"
      }
    }
  }
}
```

## How `run_select` decides

```mermaid
flowchart LR
  IN[sql: string] --> STRIP[strip -- and /* */ comments]
  STRIP --> SPLIT[split on ;<br/>honoring quoted strings]
  SPLIT --> COUNT{exactly 1<br/>statement?}
  COUNT -- no --> REJECT1[reject: multi-statement]
  COUNT -- yes --> LEADING{leading keyword<br/>in {SELECT, WITH,<br/>VALUES, TABLE, EXPLAIN}?}
  LEADING -- no --> REJECT2[reject: forbidden leading keyword]
  LEADING -- yes --> SCAN{any forbidden<br/>whole-word keyword<br/>anywhere?}
  SCAN -- yes --> REJECT3[reject: forbidden keyword present]
  SCAN -- no --> EXEC[execute]
```

The `WITH` allowance combined with the forbidden-keyword scan is what
catches the `WITH x AS (INSERT ... RETURNING ...) SELECT * FROM x` bypass.

## Reference

- MCP spec: <https://modelcontextprotocol.io/>
- `@modelcontextprotocol/sdk` (Node): <https://www.npmjs.com/package/@modelcontextprotocol/sdk>
- Postgres `default_transaction_read_only`: <https://www.postgresql.org/docs/current/runtime-config-client.html>
