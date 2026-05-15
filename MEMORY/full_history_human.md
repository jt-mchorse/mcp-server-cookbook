# Session History (human-readable)

Chronological log of work sessions. Most recent first below the divider.

---

## 2026-05-15 — Issue #1: postgres-readonly MCP server
**Duration:** ~90 min · **Branch:** `session/2026-05-15-1015-issue-01`

- Shipped `servers/postgres-readonly/` end-to-end: TypeScript MCP server on stdio transport with three tools (`describe_schema`, `run_select`, `sample_rows`), built on `@modelcontextprotocol/sdk` + `pg`. Default-deny on writes via three independent layers (D-004): read-only DB role + session `default_transaction_read_only=on` + statement-level guard (`src/sqlGuard.ts`) that strips comments + string literals, splits on `;` while honoring quoted strings, and allow-/deny-lists keywords.
- Hermetic vitest suite: 38 tests passing, covering allowed shapes (SELECT/WITH/EXPLAIN/VALUES, string-literal contents that look like keywords), explicit bypasses (`SELECT;DROP`, comment-hidden writes, `WITH x AS (INSERT ... RETURNING ...)`, `pg_terminate_backend`, `pg_sleep`, `FOR UPDATE`, `EXPLAIN ANALYZE`, `SET ROLE`, etc.), and quoted-identifier vs. quoted-string distinction.
- Sample DB via Docker compose (Postgres 16 + seed schema with FK + view + enum + `mcp_reader` role granted SELECT only). One-command bring-up so the threat model is exercised end-to-end on a fresh clone.
- Per-server `README.md` leads with the threat model (D-003): five threats enumerated with defenses + explicit out-of-scope list.
- Locked the per-server-subdirectory cookbook layout (D-002): no shared runtime, no workspaces root.
- Backfilled root README + `docs/architecture.md` with the cross-server layout, the per-server invariants, and the data-flow diagram for `postgres-readonly`.
- CI: `npm ci` → `lint` → `typecheck` → `test` → `build` per server in its own job.

**Why this work, this session:** First server in the cookbook locks the layout pattern (D-002) and the threat-model format (D-003) that issue #2 (`filesystem-sandbox`) and the unfiled servers must follow. Skipping the per-server invariants now would force a refactor when the second server lands.

**Open questions / blockers:** None. `npm audit` reports 5 moderate severity advisories from transitive dev-deps; not blocking for an MCP server example, will revisit if a real exploit lands.

**Next session:** Issue #2 (filesystem-sandbox MCP server) — same shape, allow-listed paths, explicit path-traversal rejection.
