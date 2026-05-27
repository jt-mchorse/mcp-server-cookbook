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

## 2026-05-18 — Issue #5: Python parity port (filesystem-sandbox)
**Duration:** ~55 min · **Branch:** `session/2026-05-18-issue-py` · **PR:** #14

- Shipped `servers/filesystem-sandbox-py/`: line-for-line port of the TypeScript filesystem-sandbox server to Python with full parity on the security primitive (D-005, D-006). Three tools (`list_directory`, `read_file`, `write_file`) wired to the official `mcp` Python SDK v1.27 — same upstream the TS cookbook pins.
- The MCP SDK is lazy-imported in `server.py`, so the security primitive (`sandbox.py` + `tools.py` + `config.py`) is *entirely* dep-free. Its 54 tests run on a stdlib-only Python install — stricter dep posture than the TS port can achieve.
- The Python test suite (`tests/test_sandbox.py` 22, `tests/test_tools.py` 13, `tests/test_config.py` 19) pins every security invariant the TS suite pins: empty input, null bytes, control chars, relative paths, traversal, symlinks-out, prefix-sibling overlap (`/tmp/foo` vs `/tmp/foobar`), `must_exist=False` semantics. Plus Python-idiomatic shape tests for the env parser.
- Server README is the parity doc: matrix of identical properties + idiomatic differences (sync vs async, test runner, dep posture). Root README's Quickstart gets a Python paragraph + a test row.
- No new D-NNN: this is a parity translation of existing decisions, not a new architectural commitment. The choice of `mcp` over `fastmcp` is documented in the PR description; reversibility is cheap (one file imports the SDK).

**Why this work, this session:** Last remaining open issue in the cookbook; gives the repo a *cross-language* story which is genuinely useful as a teaching artifact ("here's how the same security posture translates between SDK ecosystems").

**Open questions / blockers:** PR explicitly flags that a *running* side-by-side comparison in Claude Desktop wasn't performed inside the PR — the parity matrix + the test suite cover the wiring; the end-to-end is a manual one-shot.

**Next session:** Wrap. All open issues with actionable work across the night-target portfolio are now closed. Remaining backlog is the data-blocked embedding-shootout #4 (commented honestly, waiting on operator-triggered real-provider runs).

## 2026-05-18 — Issue #15: README truth pass + CI lock

**Duration:** ~30 min · **Branch:** `session/2026-05-18-2324-issue-15`

- Removed two stale fragments from the README. The pattern catalog read `1. Read-only data access (this PR — Postgres)` — leftover wording from when the README was authored inside `postgres-readonly`'s landing PR — and was rewritten to name each pattern's server directory. The Demo section claimed a 60s capture was "pending until at least two servers are wired up", a blocking condition that's been met for weeks (five servers ship); reframed to describe today's per-server `npm start` reality and tracked the captured asset as follow-up #16.
- Added `tools/check-readme.mjs`, a dep-free Node stdlib script in the same shape as the existing `tools/check-spec-version.mjs`. Two invariants: every `servers/<name>/` reference in the README points to a real directory, and every per-server test-count claim (`# 38 SQL-guard tests`, etc.) matches the static count from the server's test files. Handles vitest `it(`/`test(` for the TS servers and Python `def test_*` with `@pytest.mark.parametrize(...)` expansion for the Python parity port (top-level comma counter that's quoted-string-aware; stacked decorators multiply).
- 19 `node --test` unit tests cover the parser surfaces. New `readme-check` CI job runs both the script and the unit tests on every PR. Verified the failure path by tampering one count to `999`: the script exits 1 with the offending line and an actionable hint. Reverted, script clean again.
- All TS per-server counts (38 / 38 / 28 / 20) and the Python parity count (54) match what the script finds statically — same numbers `pytest` and `vitest` report at runtime.

**Why this work, this session:** A README claiming work is pending when the work has shipped is the same drift mode this repo's spec-version-check guards against for SDK pins; extending the same pattern to README claims keeps the docs honest and detectable from CI rather than from periodic manual passes.

**Open questions / blockers:** Captured 60s asset still doesn't exist — owned by #16. Live capture across three servers + an MCP client is best done with screen-capture tooling rather than in an autonomous session.

**Next session:** Substantive feature work for this repo is done. Open issues are now #16 (low) only.

## 2026-05-20 — Issue #18: lock filesystem_sandbox public surface
**Duration:** ~20 min · **Branch:** `session/2026-05-20-0330-issue-18`

- Added `servers/filesystem-sandbox-py/tests/test_public_surface.py` (4 standalone + 2 parametrized = 6 test items) and `__version__ = "0.1.0"` on the `filesystem_sandbox` package (mirrors pyproject; this package is at 0.1.0, not 0.0.1 like the prior five pattern repos). Six axes: semver, all-bound, all-matches, package-docstring-imports (novel — only Python repo in the portfolio where the "Library use" promise lives in `__init__.py`'s own docstring rather than the README), README+pyproject dotted-path `filesystem_sandbox.server.main`, one anchor for `sandbox`.
- Tamper-verified four axes: bad version, drop `"SandboxedPath"` from `__all__`, in-process delete of `server.main` (which the CLI entry-point and README's `python -m` invocation both depend on), alias-rename `Sandbox as SandboxV2` (fires three axes simultaneously).
- Full suite 60/60 in the Python sub-package (was 54; +6 new).

**Why this work, this session:** Eighth and final portable strike of the portfolio-wide public-surface hygiene pattern. This repo's TypeScript servers (`filesystem-sandbox`, `postgres-readonly`, `github-gists`) would need their own pattern translation (e.g., `tsd` or `tsc --noEmit` snapshot) and are out of scope here.

**Open questions / blockers:** None — PR ready for review.

**Next session:** The Python public-surface pattern is now complete across the portfolio (8 strikes: `llm-eval-harness#25`, `llm-cost-optimizer#23`, `prompt-regression-suite#20`, `rag-production-kit#24`, `embedding-model-shootout#14`, `chunking-strategies-lab#16`, `python-async-llm-pipelines#19`, this one). Loop forward into TypeScript hygiene, demo capture, or whichever issue surface JT highlights next.

## 2026-05-20 — Issue #20: lock public surface across all 4 TS servers
**Duration:** ~25 min · **Branch:** `session/2026-05-20-0356-issue-20`

- Added `test/public-surface.test.ts` to each of the four TS servers (`filesystem-sandbox`, `postgres-readonly`, `github-gists`, `internal-tools-bridge`). Identical 3-axis shape per server (~95 lines each): `package.json#version` semver, `package.json#main` maps to `src/server.ts` via tsconfig `rootDir=src`/`outDir=dist`, every `package.json#bin.<name>` entry maps to a real pre-build source. `src/server.ts` intentionally NOT smoke-imported because top-level `main().catch(...)` starts the MCP stdio transport on import.
- First multi-package strike in the pattern series — one PR adds the test to all four servers because they share the same shape; their CI jobs run separately.
- README test-count claims bumped to match the new totals (filesystem-sandbox 38→41, postgres-readonly 38→41, github-gists 28→31, internal-tools-bridge 20→23). Same drill that PR #19 had to do for filesystem-sandbox-py.
- Tamper-verified three axes on `filesystem-sandbox` as the representative server. All four servers: vitest passes, eslint clean, tsc --noEmit clean.

**Why this work, this session:** Thirteenth strike of the portfolio-wide public-surface hygiene pattern. With this PR, the pattern covers every Python and TypeScript package in the portfolio — twelve strikes prior + this multi-package one.

**Open questions / blockers:** None — PR ready for review.

**Next session:** Public-surface pattern is complete across the portfolio. Pivot to a different hygiene gap or wait for JT to direct.

## 2026-05-22 — docs/architecture.md was frozen at postgres-readonly's first PR, mislabeled four shipped servers as pending (#22)

**Duration:** ~30 min. **Issue:** [#22](https://github.com/jt-mchorse/mcp-server-cookbook/issues/22). **PR:** [#23](https://github.com/jt-mchorse/mcp-server-cookbook/pull/23).

`docs/architecture.md` was first committed alongside `postgres-readonly`'s first PR and never reframed when the other four servers (`filesystem-sandbox` #2, `github-gists` #3, `internal-tools-bridge` #4, `filesystem-sandbox-py` #5) landed. The directory diagram still said three of the four shipped servers were `pending`, named a never-shipped `api-with-auth` directory instead of the real `github-gists` (the API-wrapper-with-auth concrete became GitHub Gists at the D-007 decision point), didn't include `filesystem-sandbox-py` at all, and carried a `"this PR"` framing left over from when the doc was first added in `postgres-readonly`'s PR. The "Pending entries" section three quarters of the way down repeated the same staleness. The root `README.md` was already correct — only `docs/architecture.md` lagged. A reader landing on the architecture doc first (linked from the README's Architecture section) got the wrong picture.

Rewrote the directory diagram to list the five actually-shipped server directories with concise `D-NNN` annotations, and replaced the "Pending entries" section with a "Shipped entries" section naming each server's pattern, tools, and load-bearing security decision. Dropped the `"this PR"` framing; the doc is now a steady-state reference, not a PR description.

Lock-against-drift: `tools/check-architecture-doc.{mjs,test.mjs}` — a parallel to the existing `tools/check-readme.{mjs,test.mjs}` checker. Three invariants: every `servers/<name>/` path token in the doc resolves to a real directory; every existing `servers/<name>/` directory is referenced at least once (catches a future sixth server shipping without the doc updating); none of `api-with-auth`, `pending issue`, `pending (not yet filed)`, `this PR` appear (the exact four shapes the pre-#22 doc carried). CI gains a new `architecture-doc-check` job running both the script and its 8 unit tests on every PR — same shape as the existing `readme-check` and `spec-version` jobs.

Tamper-verified two ways: reinjecting all four banned phrases on a scratch copy fires the stale-phrase assertion with each one quoted in the error; stashing the doc fix fires the unreferenced-servers assertion with the four missing names listed.

Issue #22 was filed in-session — third drift fix of this session and the eleventh in the portfolio pattern. Open questions / blockers: none. Next session: continue the multi-issue loop or stop cleanly within the cap.


## 2026-05-23 — Architecture-doc lock gains active-decision-range + shipped-issue axes (#25)

**Duration:** ~30 min. **Issue:** [#25](https://github.com/jt-mchorse/mcp-server-cookbook/issues/25). **PR:** TBD (this session).

Extended `tools/check-architecture-doc.mjs` from three invariants to five, applying the portfolio-wide upper-bound axis pattern shipped over the past two sessions in `llm-eval-harness` (#32), `prompt-regression-suite` (#27), `embedding-model-shootout` (#22), `vector-search-at-scale` (#24), `nextjs-streaming-ai-patterns` (#21), and earlier in `rag-production-kit`, `llm-cost-optimizer`, `python-async-llm-pipelines`, and `chunking-strategies-lab`. With this PR, ten of twelve repos carry the active-decision-range axis on their architecture-doc lock; only `ai-app-integration-tests` remains.

The two new axes:

1. **Active-decision coverage.** `MEMORY/core_decisions_ai.md` is parsed for non-superseded `D-NNN >= 2` entries; the architecture doc must cite every one. Parsing is regex-only (split on `^- id:` block boundaries, grep `superseded_by` per block); no YAML-parser dep is added, matching the dep-free CI posture and D-008's spirit. A doc citation of `D-7`, `D-07`, or `D-007` all normalize to id `7`, so the lock doesn't trip on stylistic choice.

2. **Closed-feature-issue coverage.** `KNOWN_SHIPPED_ISSUES = [1, 2, 3, 4, 5]` (the five shipped cookbook entries: `postgres-readonly`, `filesystem-sandbox`, `github-gists`, `internal-tools-bridge`, `filesystem-sandbox-py`); the doc must reference every one. A future sixth server shipping under `#N` must bump the array AND add a doc reference — the hard-pin test makes the former unmissable.

Both `MIN_ACTIVE_DECISION_ID = 2` and `KNOWN_SHIPPED_ISSUES = [1..5]` are hard-pinned in `tools/check-architecture-doc.test.mjs` with comments naming why each value is load-bearing. Eight new node:test cases cover the parser shapes (sorted output, superseded skipped, missing-superseded-by treated as active, leading-zero `D-NNN` citations tolerated, declared-order preservation for the missing list).

Tamper-verified two ways: appending a synthetic `D-099` with `superseded_by: null` to the decisions file → axis 4 fires naming `D-099`; `sed -i.bak 's/#1[^0-9]/__/g'` stripping `#1` from the doc → axis 5 fires naming `#1`. Doc itself didn't need changes — D-002 through D-009 are all already cited in the current `docs/architecture.md`, and the five `#N` annotations are already there in the directory diagram and Shipped-entries section. Real-drift-caught count is zero on first run; the axes exist to catch *future* drift.

A small JS scoping gotcha: my first pass named the new local `const unreferenced` inside `main()` to mirror invariant 2's variable, which collided in the same function scope; Node's ES-module strict mode caught it at load time with `SyntaxError: Identifier 'unreferenced' has already been declared`. Renamed to `unreferencedDecisions` and the script loads.

**Why this work, this session:** Second of (target) 2–4 issues in this DAY session, after Phase A merged five clean architecture-doc-axis PRs from the prior session. The active-decision-range upper-bound axis was missing in three repos (mcp-server-cookbook, ai-app-integration-tests, plus the agent-orchestration-platform recheck which turned out to already have it from #23). mcp-server-cookbook is build-sequence position #10 — earlier than `ai-app-integration-tests` at #12 — so it goes first, leaving the latter for the next loop iteration of this session.

**Open questions / blockers:** None — PR ready for review when CI is green.

**Next session:** Apply the same axis to `ai-app-integration-tests` (`test/architecture-doc.test.ts`, vitest). That closes the active-decision-range upper-bound axis across all twelve repos.

## 2026-05-24 — 60-second demo capture orchestrator (#16, AC3 of 3)

**Duration:** ~30 min. **Issue:** [#16](https://github.com/jt-mchorse/mcp-server-cookbook/issues/16). **PR:** [#27](https://github.com/jt-mchorse/mcp-server-cookbook/pull/27).

Fifth and final issue in the day-session multi-issue loop, after `llm-eval-harness#33`, `llm-cost-optimizer#29`, `prompt-regression-suite#28`, `rag-production-kit#31`. First TypeScript/Node repo in the loop — the orchestrator is ported to Node stdlib so it lives alongside the existing `tools/check-*.mjs` suite with no new deps.

The cookbook's recording is uniquely operator-driven: only an MCP client (Claude Desktop or Claude Code CLI) can actually invoke a server's tool, so the script can't itself drive the demo. What it *can* do — and what AC3 actually asks for — is lock the **inputs** to those tool calls so the recording's arguments and results are byte-stable across re-captures.

Three stages, one per server:

- **STAGE 1 (postgres-readonly).** Prints the sha256 of `servers/postgres-readonly/sample-db/init.sql` so the operator can verify the seed hasn't drifted between recordings. `--launch-postgres` optionally `docker compose up -d`. Cheat-sheet covers `describe_schema` + a `DELETE FROM orders` that fails *both* server-side parsing AND the read-only role (D-004 defense in depth) — the recording shows both error paths.

- **STAGE 2 (filesystem-sandbox).** Creates `/tmp/mcp-demo-fs-sandbox/` with a known small layout (`hello.txt` + `nested/note.md`) on every run. Cheat-sheet shows the `MCP_FS_SANDBOX_ALLOWLIST` env var the operator pastes into the server's startup command + the two `read_file` invocations (success inside the allow-list, blocked traversal against `/etc/passwd`).

- **STAGE 3 (github-gists).** Reads the fixture gist ID from a new `docs/demo_fixture.md` (the script falls back to a placeholder when the file or field is missing). Cheat-sheet covers `get_gist` success + a 404 against a non-existent gist that exercises D-007 token redaction (the recording shows the bearer value isn't in the error message).

`tools/capture-demo.test.mjs` adds **14** `node:test` unit tests under the same posture as `tools/check-*.test.mjs`. New CI job `capture-demo-test` runs them alongside the existing `readme-check` and `architecture-doc-check` jobs. README "Demo" section gains a one-line forward reference to the new script + `docs/demo_fixture.md`; the existing `check-readme.mjs` and `check-architecture-doc.mjs` invariants still pass.

**Why this work, this session:** Last loop iteration. With this PR, every one of the seven `[demo]` GIF/MP4 issues in the portfolio has its AC3 row landed (the five new capture scripts in this loop's PRs plus the two pre-existing scripts in `nextjs-streaming-ai-patterns` and `ai-app-integration-tests`). The day-session's primary goal — multi-issue, multi-repo close pattern — completes here.

**Open questions / blockers:** AC1 + AC2 are operator-only across all seven `[demo]` issues. The next operator-action work-shape is the screen recording sweep: seven GIFs / MP4s, one per repo, README embed in each. Nothing Claude can pre-stage further.

**Next session:** Portfolio is now genuinely quiescent on `priority:low` (and above). When trending intake or operator filing produces new issues, work resumes; otherwise the script-coverage layer is at 7 of 7 and waiting on operator recordings.

## 2026-05-24 — Issue #28: `GithubApiError` surfaces request-id + rate-limit headers

**Duration:** ~25 min. **Issue:** [#28](https://github.com/jt-mchorse/mcp-server-cookbook/issues/28). **Branch:** `session/2026-05-24-0411-issue-28`.

The github-gists server's `GithubApiError` carried `status`, `endpoint`, and a redacted `reason` — but threw away two routine GitHub diagnostic surfaces: `X-GitHub-Request-Id` (load-bearing for opening GitHub support tickets) and the `X-RateLimit-*` / `Retry-After` triad (needed for any rate-limit-aware retry decision). A caller hitting a 403 "rate limit exceeded" or 429 secondary rate limit had no programmatic way to know when to retry without re-parsing the response themselves.

Extended `FetchLike` with a minimal `HeadersLike` interface (`get(name)` only — matches WHATWG `Headers` so native fetch satisfies it). `GithubApiError` gained four readonly nullable fields (`requestId`, `rateLimitRemaining`, `rateLimitResetEpoch`, `retryAfterSeconds`) via an optional fourth constructor arg with sane null defaults, so existing callers stay byte-compatible. A new exported `extractGithubDiagnostics(headers)` helper does the read; both throw sites in the client (GET, PATCH) wire it through. Missing or unparseable headers leave fields `null` — observability helpers must never break the error path.

The error `message` is unchanged in shape and explicitly never contains the header values themselves; one of the five new tests verifies the redaction posture (D-007) is preserved even with the new fields populated. The other four tests cover the three header families (request-id, rate-limit triad, retry-after) plus a regression guard that a 500 with no diagnostic headers leaves all four fields `null` and the existing message format unchanged.

The repo-level README lock test caught a side effect: the github-gists test-count claim went from 31 to 36 (5 new tests), so bumped the README's per-server line accordingly. Now the README and the test count are co-locked again.

**Why this work, this session:** Tenth issue in the night-session multi-issue loop. Third observability/safety gap fix tonight (after `python-async-llm-pipelines` #26's per-tool timeout and `agent-orchestration-platform` #25's retry-cap/jitter). The pattern: every repo had at least one production-realism surface that read cleanly from the source.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue to build-sequence #11 (`nextjs-streaming-ai-patterns`) if loop continues; otherwise wrap.

## 2026-05-24 — Issue #30: `errorMessage()` surfaces GithubApiError diagnostics through the MCP boundary

**Duration:** ~20 min. **Issue:** [#30](https://github.com/jt-mchorse/mcp-server-cookbook/issues/30). **Branch:** `session/2026-05-24-1523-issue-30`.

#28 added `requestId`, `rateLimitRemaining`, `rateLimitResetEpoch`, and `retryAfterSeconds` to `GithubApiError` and pinned them at the client layer. But `servers/github-gists/src/server.ts`'s `errorMessage()` only forwarded `err.message` — so the rich fields were populated on the error object and never reached an MCP consumer. A 429 with `Retry-After=60` looked like `too many requests` to the caller with no backoff window visible. This PR finishes the half-implemented #28.

New `formatGithubApiError(err)` helper in `client.ts` (not `server.ts` — because `server.ts` has a top-level `main().catch(...)` that starts the stdio transport on import, so importing it from a test would actually try to start a server) builds the single-line shape `<base> | request-id=X rate-limit-remaining=Y rate-limit-reset=Z retry-after-seconds=W`. Null fields are omitted (no `field=null` noise); when every diagnostic field is null the base message is returned verbatim — the back-compat path for non-GitHub callers and proxies that strip the headers. `server.ts`'s `errorMessage()` routes `GithubApiError` through the helper; the other error classes are unchanged.

Five new tests in `servers/github-gists/test/format-github-api-error.test.ts`. The notable ones: `rate-limit-remaining=0` is the load-bearing case (you're at the cap) — the implementation must use `!== null` not truthiness, and there's a dedicated test that pins this. A second invariant-pinning test asserts the diagnostic suffix never leaks `GITHUB_TOKEN`-shaped material — D-007 (token redaction at error boundaries) is preserved even with the new fields populated.

README bumped from 36 to 41 tests for github-gists and the error-message contract is now documented under the server's quickstart section so clients can grep `request-id` / `rate-limit-remaining` / `rate-limit-reset` / `retry-after-seconds` verbatim.

**Why this work, this session:** Third Phase B+C target of a 180-min day session, after `llm-eval-harness` #37 and `prompt-regression-suite` #32. The pattern across all three is the same: a previous PR added the capability one layer down and the polish PR surfaces it at the public boundary.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue the day-session loop. Strong next candidates by build sequence: `embedding-model-shootout` (#5), `chunking-strategies-lab` (#6), `vector-search-at-scale` (#7). Survey each CLI / test surface for analogous polish gaps — half-implemented features whose top layer never reached the user.

## 2026-05-25 — Issue #32: internal-tools-bridge validateConfig blocks degenerate BridgeConfig at runBridged entry
**Duration:** ~30 min · **Branch:** `session/2026-05-24-issue-32`

- `BridgeConfig` fields were typed as plain `number`/`string` and not runtime-validated. Four concrete sites silently undermined D-009 ("output cap plus timeout means runaway CLI can't OOM or hang the server"): `timeoutMs = 0` (instant timeout because `setTimeout` fires next tick), `maxOutputBytes = 0` (every chunk satisfies `> 0` and trips the cap), `allowlist` entries that aren't absolute paths (PATH lookup inside `spawn` widens attack surface — D-009's "no shell" guard does nothing about `$PATH`), `cwd` not absolute (resolves against `process.cwd()`, violates "locked root" guarantee). The field docstrings already said "Must be absolute"; the check was missing.
- Added `validateConfig(cfg)` at the entry of `runBridged`, before the allowlist check and before spawn. Each invalid field throws `BridgeError` naming the field and value. `path.isAbsolute` guards catch the two security-relevant cases (`allowlist` entries + `cwd`); `Number.isInteger(x) && x >= 1` guards catch the two operational cases (`timeoutMs` + `maxOutputBytes`). Defaults (`DEFAULT_TIMEOUT_MS`, `MAX_OUTPUT_BYTES`) and back-compat paths (undefined fields preserve defaults) are unchanged.
- 13 new tests in `servers/internal-tools-bridge/test/bridge.test.ts` under an issue-`#32` `describe` block: per-field rejection (zero, negative, fractional, NaN, +Infinity, relative-path, empty-string); boundary acceptance at `1` / `1` / absolute path; one "validation before spawn" pin that proves a relative allowlist entry raises `BridgeError` (validation) not `AllowlistError` (post-validation) — critical so the entry-site placement can't drift. Plus a `maxOutputBytes=1` acceptance test exercising the existing `OutputCapError` path with the smallest valid cap. Bridge tests 29/29 (was 16). Package overall 42/42 (was 29).

**Why this work, this session:** Third Phase B+C target in the 360-min night session. Second TypeScript repo to ship the contract-tightening sweep pattern. The first (`agent-orchestration-platform` #29) used entry-function validation as the TS analogue of Python's `__post_init__`; this one extends the pattern to a server module whose existing protective intent (D-009) was already documented but operator-overridable. The validateConfig pattern now lives in two TS repos and seven Python repos.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue the loop. `nextjs-streaming-ai-patterns` (build seq #11) and `ai-app-integration-tests` (build seq #12) are the next unvisited-tonight repos.

## 2026-05-25 — Issue #32 (docs sync): READMEs lagged validateConfig sweep
**Duration:** ~10 min · **Branch:** `session/2026-05-24-issue-32` (existing PR #33)

- The validateConfig commit (de521e0) shipped 13 new tests (2 `it.each` tables × 5 cases + 3 singletons) but didn't refresh either of the two test-count claims. Top-level `README.md` line 111 quoted "23 tests" (the static counter `tools/check-readme.mjs` now sees 32 because each `it.each` counts as 1 statically). Per-server `servers/internal-tools-bridge/README.md` line 145 quoted "20 tests (10 bridge, 10 tools)" — staler still; runtime is 42 because each `it.each` expands to 5.
- Bumped both: top-level to 32 (CI-enforced static count), per-server to 42 (what `npm test` actually outputs). The deliberate discrepancy is a feature, not a bug — the top-level count is a contract against source-text drift; the per-server count is what a human sees on their terminal.
- Confirmed `node tools/check-readme.mjs` exits 0 locally before pushing. CI should be clean.

**Why this work, this session:** Phase A's PR review pass found `mcp-server-cookbook#33` failing readme-check while the other 11 ready PRs across the portfolio were green. Fixing it unblocks the merge and closes #32 — the only `priority:high` issue across all 12 repos.

**Open questions / blockers:** none — PR ready for re-evaluation.

**Next session:** Continue Phase B+C loop on the next repo with actionable work.

## 2026-05-26 — Issue #34: GistsClient constructor validation completes the #32 sweep
**Duration:** ~25 min · **Branch:** `session/2026-05-26-0000-issue-34`

- `GistsClient.constructor` previously consumed `deps.cfg.timeoutMs` directly without validation, while the sibling `internal-tools-bridge` had `validateConfig` at `runBridged` entry (#32). The env-reading layer at `servers/github-gists/src/config.ts:57-67` guards the standard path, but programmatic construction (tests, embedding apps, alternate config sources) was unguarded. Added a `validateConfig` helper above the `GistsClient` class with the same shape as the internal-tools-bridge version (Number.isInteger + < 1 + RangeError naming field and value); called as the first statement in the constructor.
- Closed five silent failure modes — per ES2024 spec, `setTimeout` coerces NaN / negative / Infinity silently: `timeoutMs=NaN` made every request error with `RequestTimeoutError` immediately (silently disables the client), `timeoutMs=Infinity` clamped to setTimeout's max delay (~50 days, effectively no timeout — operator deadline silently removed), `timeoutMs=1.5` implementation-dependent truncation, `timeoutMs=-1` clamped to 0 same as NaN, `timeoutMs=0` immediate fire.
- 18 new collected test cases (11 it.each reject + 6 it.each accept + 1 message-shape pin) in `servers/github-gists/test/client.test.ts`. Full per-server test count 59 (was 43). Top-level README test-count claim updated from 41 → 43 (the static counter sees `it.each` blocks as single entries per the prior memory note on static-vs-runtime semantics). Per-server README left unchanged per the documented intentional split.

**Why this work, this session:** Seventh Phase B+C target in the 360-min night session and second TypeScript Phase B+C PR (after `agent-orchestration-platform#32`). Picked via build-sequence #10. The `GistsClient` constructor was the only Client class in the repo without entry-time numeric validation after #32 tightened `internal-tools-bridge`.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue the loop. `nextjs-streaming-ai-patterns` (build #11) and `ai-app-integration-tests` (build #12) are the remaining TS repos. After those, the validation-sweep arc has comprehensively touched every portfolio repo.

## 2026-05-26 — Issue #36: `atomicWriteFile` closes the cross-language atomicity arc
**Duration:** ~25 min · **Branch:** `session/2026-05-26-1533-issue-36`

- `servers/filesystem-sandbox/src/tools.ts:97` used `fs.promises.writeFile` directly. Non-atomic: opens with `O_WRONLY | O_CREAT | O_TRUNC` (truncates immediately), commits bytes on completion. Worst shape for an MCP tool: clients re-read what they wrote, so a SIGINT/SIGTERM/OOM mid-write produces a half-written file that corrupts the conversational context. Subsequent `readFile` calls observe truncated text; the LLM keeps editing forward on broken state. File-watching editors reload partial contents. Build steps cascade-fail with unrelated-looking errors.
- Added `servers/filesystem-sandbox/src/atomic_write.ts` exporting `atomicWriteFile(target, data)`. Sibling temp filename via `path.dirname(target)` + `crypto.randomBytes(6).toString("hex")` + `process.pid`. Open with `O_WRONLY | O_CREAT | O_EXCL` (collision with a concurrent process attempt fails loud), write, `handle.sync()` (fsync), close, `fs.rename` (atomic on POSIX same-filesystem; same-directory placement is load-bearing). Try/finally unlink cleanup on failure.
- TypeScript cross-language sibling of the four Python helpers landed earlier today (`llm-eval-harness#48`, `llm-cost-optimizer#42`, `prompt-regression-suite#39`, `rag-production-kit#44`). Same shape, same load-bearing constraints, same set of invariants.
- `tools.ts::writeFile` (line 97) routed through it. Upstream sandbox / read-only / size checks unchanged.
- 8 new tests in `test/atomic_write.test.ts`: six helper unit invariants (the standard set, with `Buffer.equals` for the bitwise-preservation invariant) plus two integration tests through `tools.ts::writeFile`. The load-bearing integration test is `two awaited writers targeting the same path produce one winner, no corrupt blend`: `Promise.all` of two writers (one writing `"x".repeat(2000)`, the other `"y".repeat(2000)`) to the same path, then assert the on-disk content is exactly one writer's payload in full (2000 bytes, all of "x" or all of "y") — proving the rename atomicity serializes the writes wholesale. Full vitest suite 41 → 49 passing. Typecheck and lint clean.

**Why this work, this session:** Fifth Phase B+C target in today's 180-min DAY session and the first TypeScript implementation in the atomicity arc. The Python arc closed in four repos earlier today established the helper shape; this lands the same shape in a TypeScript MCP tool where the client-facing contract is **more** sensitive to non-atomic writes than a typical CLI artifact — MCP clients re-read what they wrote.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Atomicity arc now spans five repos (four Python, one TypeScript). The helper shape is proven portable across languages. Three TypeScript repos remain that *might* host similar writes — `agent-orchestration-platform` (trace artifacts), `nextjs-streaming-ai-patterns` (no obvious file writes; SSR-only), `ai-app-integration-tests` (cassette file writes during recording). The next natural session could pick the highest-blast-radius of those if continuing the arc, or pivot to a fresh harm class entirely.

## 2026-05-26 — Issue #38: README decision-range upper-bound lock
**Duration:** ~10 min · **Branch:** `session/2026-05-26-2337-issue-38`

- Extended `tools/check-readme.mjs` with `maxActiveDecisionId()` and `readmeDecisionRangeBound()`.
- Wired a third invariant into the existing `readme-check` CI job.
- Added 7 tests + `D-002…D-009` citation under `## Architecture`.

**Why this work, this session:** Propagation 9 of 10 of the cross-portfolio drift class. Extending the existing tool rather than adding a new one keeps the CI surface unchanged and matches D-008's dep-free spirit.

**Open questions / blockers:** none.
**Next session:** Continue to nextjs-streaming-ai-patterns.

## 2026-05-27 — Issue #40: internal-tools-bridge claude_desktop_config snippet + portfolio lock
**Duration:** ~20 min · **Branch:** `session/2026-05-27-0316-issue-40`

- `internal-tools-bridge` was the only server with Claude Desktop wiring described in prose ("Or wire it into Claude Desktop / a custom MCP client by registering `node dist/server.js`") rather than as a copy-pastable JSON snippet. The other four servers shipped a fenced `claude_desktop_config.json` block. The asymmetry broke handoff §2's "each server installable and usable from Claude Desktop or Cowork itself in <5 minutes" criterion.
- Added a "Wire into Claude Desktop" section to the bridge README with `command`, `args`, and the optional `MCP_BRIDGE_CWD` env field, matching the shape and tone of the four other server snippets.
- New lock: `tools/check-claude-desktop-config.mjs` (dep-free Node, 5 exported helpers + a `main()`). Scans every `servers/*/README.md` for a fenced ```json / ```jsonc block containing both `"mcpServers"` and `"command"` substrings — the minimum-viable Claude Desktop config shape. Intentionally narrow: doesn't prescribe a header phrasing because the existing four blocks already use four different phrasings ("Wire into Claude Desktop", "Wiring into Claude Desktop", "Run (Claude Desktop)", "To attach it to Claude Desktop, add to its claude_desktop_config.json").
- 9 `node:test` cases in `tools/check-claude-desktop-config.test.mjs` covering fence parsing (with `jsonc` variant), the validity predicate's pass/fail axes, scanner pass/fail/missing-README paths, and the directory lister.
- Wired into the existing `readme-check` CI job (two new run steps; no new jobs). Verified the lock loud-fails when the section is removed (exit 1) and passes when restored (exit 0).

**Why this work, this session:** Iteration 2 of an autonomous NIGHT session loop. The portfolio's validation arc was saturated; pivoting to per-repo doc-hygiene gaps surfaced this asymmetry. Same drift-class fix shape as the earlier README decision-range lock and architecture-doc lock.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Loop continues across the 12 portfolio repos this NIGHT session.
