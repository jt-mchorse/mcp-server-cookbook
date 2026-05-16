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

## 2026-05-16 — Issue #2: Filesystem sandbox MCP server
**Duration:** ~50 min · **Branch:** `session/2026-05-16-0455-issue-2`

- Shipped the second cookbook entry under `servers/filesystem-sandbox/` following the per-server-subdir pattern locked in D-002. Three tools: `list_directory`, `read_file`, `write_file`, with every input path routed through `Sandbox.resolve()` before any filesystem syscall.
- `src/sandbox.ts` is the core: `Sandbox.create(roots)` resolves allow-list paths via `fs.realpath` once (D-005); per-call resolution uses `fs.realpath` again so a symlink under the allow-list pointing outside cannot succeed (D-006). Containment is a trailing-slash prefix match so `/tmp/foo` doesn't accidentally accept `/tmp/foobar/x`.
- Validation surface rejects: relative paths, null bytes, ASCII control characters, empty input, non-existent paths (unless `mustExist: false` for write-targets-that-don't-exist-yet, in which case the parent's containment is checked).
- `src/config.ts` parses `MCP_FS_SANDBOX_ALLOWLIST` (colon-separated absolute paths); empty/unset refuses to start — silent permissive default would be the worst failure mode. `MCP_FS_SANDBOX_READ_ONLY` flips writes off entirely; `MCP_FS_SANDBOX_MAX_BYTES` caps per-call byte size at 1 MB default.
- 38 hermetic tests across `test/sandbox.test.ts` (20: path traversal, symlinks outside, null bytes, control chars, non-existent paths, sibling roots, root-as-directory), `test/config.test.ts` (8: env parsing, refusal on empty allow-list, read-only flag semantics, max-bytes validation), `test/tools.test.ts` (10: list_directory + read_file + write_file behavior, error mapping). Eslint + typecheck clean.
- README leads with an explicit "Threat model" section per D-003: what the sandbox protects against, what it does *not* (resource exhaustion, DoS, legitimately-misconfigured allow-list), trust assumptions.
- Root README updated with the second server's quickstart and test command. The cookbook now has two of the four planned servers (postgres-readonly + filesystem-sandbox); api-wrapper-with-auth and internal-tools-bridge are pending priority:med issues.

**Why this work, this session:** #2 was the last priority:high in the cookbook. With it shipped, the repo has two complete servers + threat models + tests, which is enough to demonstrate the cookbook pattern even before the remaining two servers land.

**Open questions / blockers:** None. The remaining cookbook servers (api-wrapper, internal-tools-bridge) are priority:med and follow the same shape.

**Next session:** All v0.1-critical work shipped in mcp-server-cookbook; move to a different repo.
