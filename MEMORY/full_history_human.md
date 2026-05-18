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

## 2026-05-17 — Issue #6: Pin MCP spec version + CI drift check
**Duration:** ~35 min · **Branch:** `session/2026-05-17-2318-issue-6`

- Wrote `docs/spec-version.md` — single source of truth for the `@modelcontextprotocol/sdk` version every server pins to. Carries a fenced YAML block with `sdk_package`, `sdk_version` (the canonical pin), `mcp_spec_revision` (informational, sourced from SDK release notes), `mcp_spec_url`, and an explicit bump procedure (release notes → doc → servers → lockfiles → local script run → PR). The block is machine-parseable; the script's tests cover the parser edge cases (comments, single-quote values, missing fences).
- Built `tools/check-spec-version.mjs` — Node stdlib only, dep-free, runs in CI without an install step. Enforces two invariants: (1) every `servers/*/package.json` declares the SDK at the exact version pinned in the doc, and (2) every server pins the same value (intra-repo consistency, which falls out for free because every server is compared against the same expected string). Failure messages name the file that drifted and point at the bump procedure. Exit codes 0/1/2 (clean / drift / bad input).
- 14 hermetic tests in `tools/check-spec-version.test.mjs` using `node:test` (no test-runner dep). Parser (extract fields, no block, comments+blanks, single-quoted values), `findServerPackageFiles` (lists servers, skips `node_modules`, returns `[]` cleanly when `servers/` is absent), `readSdkPin` (deps + devDeps + missing), and the pure-function `check` (clean pass, drift fails with location, missing dep fails, no-servers fails, intra-repo invariant). All pass under Node 25 locally; CI runs Node 20.
- Wired a `spec-version` CI job that runs both the check script and its own tests. Mirrors the existing `postgres-readonly` and `github-gists` jobs in shape.
- README gets a `Spec alignment` section pointing at the doc and the CI gate; brief mention of the bump procedure lives in the doc itself.
- Recorded D-008: canonical SDK version lives in `docs/spec-version.md` as a markdown source-of-truth, the CI script enforces conformance. Alternative rejected: read from one designated server's `package.json` and broadcast (silently silos the decision in code, hostile to reviewers).
- Note: Node 25's strict parser balked at a JSDoc comment containing the word `package` inside backticks. Switched the script header to plain `//` comments. Node 20 (CI) would have been fine either way, but the local-dev environment matters.

**Why this work, this session:** Issue #6 is one of two remaining `priority:med` open issues in this repo and tightly scoped (45-min estimate, came in at 35 min). The other (#4, internal-tools bridge) needs more design surface; #6 is purely a discipline gate that protects the cookbook's "aligned to current MCP spec" claim from drifting silently.

**Open questions / blockers:** None. The doc's `mcp_spec_revision` is sourced from the SDK 1.5.x release notes; an upstream-modelcontextprotocol.io verification is intentionally left as a manual operator step in the bump procedure to avoid CI DNS flakes.

**Next session:** Issue #4 (internal-tools bridge MCP server) is the last `priority:med` open in this repo. With it shipped, the cookbook hits its v0.1 quality bar (four servers).

## 2026-05-18 — Issue #4: Internal-tools bridge MCP server
**Duration:** ~50 min · **Branch:** `session/2026-05-18-issue-04` · **PR:** #12

- Added the fourth cookbook entry: `servers/internal-tools-bridge/`. Bundles a dep-free Node CLI (`bin/repo-stats.mjs`) that walks a directory and returns file counts by extension + total bytes; wraps it as the MCP tool `repo_stats(path, max_depth?)`. The interesting code is `src/bridge.ts`, a `child_process.spawn` helper that pins every security-relevant layer: `shell: false`, absolute-path binary allowlist, env scrubbed to a documented passlist, per-call 10s timeout, 1 MiB per-stream output cap. Each layer has a regression test that would fail loudly if removed.
- 20 hermetic tests (10 bridge, 10 tools) covering allowlist enforcement, shell-metacharacter pass-through, env scrub against a planted sentinel, timeout, output cap, cwd lock, non-zero exit, input validation, real-CLI execution against tmp fixtures. Lint + typecheck + build clean.
- Root README: servers list now lists 4 patterns (postgres-readonly, filesystem-sandbox, github-gists, internal-tools-bridge); decisions list gains D-009. CI workflow gains an `internal-tools-bridge` job mirroring the existing per-server shape (Node 20, npm ci → lint → typecheck → test → build). The drift-check workflow confirms 4 servers now agree on `@modelcontextprotocol/sdk@^1.5.0`.

**Why this work, this session:** Issue #4 was the next med-priority item in the cookbook with a contained, security-narrative-rich scope that completes the four-pattern lineup the repo's READMEs have been promising since #1.

**Open questions / blockers:** None.

**Next session:** nextjs-streaming-ai-patterns #4 or #5 (frontend pattern session).

## 2026-05-18 — Issue #10: filesystem-sandbox CI job
**Duration:** ~10 min · **Branch:** `session/2026-05-18-issue-10` (stacked on PR #12) · **PR:** #13

- Added the missing `filesystem-sandbox` job in `.github/workflows/ci.yml`. Byte-identical shape to the other three per-server jobs (Node 20, npm cache keyed on the lockfile, npm ci → lint → typecheck → test → build).
- Local pre-flight on `servers/filesystem-sandbox/`: 38 tests pass, lint + typecheck + build clean.
- No new D-NNN entry — this was a pure CI-gap fill flagged during #3, no architectural decision in play.

**Why this work, this session:** Low-priority issue, but small and complementary to PR #12's CI restructuring. Closing it now while the workflow is fresh.

**Open questions / blockers:** None.

**Next session:** Likely rag-production-kit #8 (the only remaining med-priority issue across the portfolio).
