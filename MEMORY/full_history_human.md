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

## 2026-05-16 — Issue #3: github-gists API-wrapper MCP server
**Duration:** ~60 min · **Branch:** `session/2026-05-16-1920-issue-3`

- Shipped the third cookbook entry under `servers/github-gists/` — the API-wrapper-with-auth pattern, demonstrated against the GitHub Gists REST API. Two tools: `get_gist(gist_id)` (auth optional, used for public reads + private reads + rate-limit headroom) and `update_gist_file(gist_id, filename, content, description?)` (auth required, surfaces `TokenRequiredError` before any network call when `GITHUB_TOKEN` is unset).
- Recorded D-007: token-bearing servers redact auth at error boundaries and drop the request body from error context. The `Authorization` header is built inside `GistsClient` and never leaks into a tool response, an error message, or a log line; error messages carry HTTP status + endpoint + the upstream `message` field (capped at 200 chars when the body isn't JSON), nothing else. Tests assert directly that a 401 against a configured token does not surface the token value.
- Per-file response cap (100 KB): files larger than the cap come back with `truncated: true` and `content: null` so a multi-megabyte committed file can't blow the MCP response budget; the API's own `truncated` flag is also honored.
- Injectable `fetch` seam — `GistsClient` takes a `FetchLike` so all 28 hermetic tests (9 config + 12 client + 7 tools) drive request shaping, header content, error mapping, timeout-as-`RequestTimeoutError`, and the redaction posture without any live GitHub call. Real-API smoke is operator-triggered locally; CI stays token-free.
- Per-server README leads with a threat model per D-003: protects against token leak via tool results / logs, confused-deputy writes (no token = refuse, not 401), config drift (bad base URL refuses to start), tool-result size blowup, hung calls; explicitly does NOT protect against the token being valid for too many things, rate-limit DoS, accidentally-public gists, audit logging, SSRF via an attacker-controlled base URL.
- CI: added a `github-gists` job mirroring the postgres-readonly job shape (npm ci → lint → typecheck → test → build) — the cookbook now has 3 servers + 2 CI jobs. Filesystem-sandbox CI gap will be filed as a separate priority:low followup so this PR stays focused on issue #3.
- Root README updated with the third server's quickstart, test command, and a new D-007 bullet under "Why these decisions".

**Why this work, this session:** Issue #3 is the lowest-numbered open priority:med in this repo and exactly the next planned cookbook entry. The threat-model + per-server-subdir patterns from D-002/D-003 carried over cleanly; the only new decision needed was D-007 (token redaction posture), which generalizes to any future credential-holding server in the cookbook (Notion, Linear, Slack, etc.).

**Open questions / blockers:** None. PR will go up for review per D-004; the next scheduled session can squash-merge.

**Next session:** Issue #4 (internal-tools bridge) or #6 (pin MCP spec version) — both small. The cookbook is now within one server of its v0.1 quality bar.
