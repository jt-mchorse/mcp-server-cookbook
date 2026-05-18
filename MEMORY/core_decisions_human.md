# Core Decisions

Strategic decisions for this repo, with reasoning. Append-only — superseded decisions are marked, not removed.

## D-001 — Scope locked to portfolio handoff §2 (2026-05-10)
**Decision:** Scope of this repo is fixed by the portfolio handoff document, section 2.

**Why:** The handoff spec was deliberated; ad-hoc scope expansion within a session is the failure mode this prevents.

**Alternatives considered:** None — this is a baseline.

**Reversibility:** Expensive. Scope changes require a deliberate revisit and a new decision entry.

**Related issues:** —

## D-002 — Per-server subdirectories, no shared runtime, no workspaces root (2026-05-15)
**Decision:** Each MCP server in this repo lives in `servers/<name>/` with its own `package.json`, `tsconfig.json`, ESLint/Vitest configs, README, and tests. There is no root `package.json` declaring workspaces, and there is no shared runtime package that the servers all import.

**Why:** This is a *cookbook*, not a framework. The success criterion is that a reader can copy one entry into their own project without dragging in five sibling abstractions. A workspaces root would couple the servers' dep graphs (one server's TypeScript or Vitest version would constrain the others' choices), which is exactly the coupling we don't want. If a future server genuinely needs a sibling, it can declare an explicit cross-server dependency in its own package.json — visible in code, not implicit through hoisting.

**Alternatives considered:**
- npm workspaces root — rejected because it couples dep graphs and creates implicit hoisting.
- Shared runtime package (`@mcp-cookbook/shared`) — rejected because three or four servers don't justify a shared abstraction; copy-and-paste until at least four entries demand the same shape.
- pnpm monorepo — same coupling concern, plus it adds a tool dependency for something the project doesn't need.

**Reversibility:** Cheap. A future workspaces conversion is purely additive (add a root package.json, add `workspaces:` field, no per-server changes required).

**Related issues:** #1

## D-003 — Every server README leads with an explicit threat model (2026-05-15)
**Decision:** Every server in `servers/<name>/README.md` opens with a "Threat model" section that enumerates the threats the server defends against, the defenses against each, and the threats it does NOT defend against (out-of-scope).

**Why:** The handoff §2 spec for this repo says "each server: README, security notes, install instructions, example client usage." Security notes alone aren't enough — they have to be *visible* and *structured*, because the failure mode for security writeups is burying the threat model in a "Notes" section the reader skims past. Leading with the threat model makes the security posture the first thing the reader sees, and the explicit out-of-scope list makes the operator's responsibilities unambiguous.

**Alternatives considered:**
- Shared security doc at repo root — rejected because per-server threat models differ enough that a single document either says too little (useless) or has to be re-read entirely for each server (worse than per-server READMEs).
- Threat model as an optional appendix — rejected because optional security writeups are skipped writeups.

**Reversibility:** Cheap. Easy to enforce by lint at PR review time if needed; for now an explicit decision + a check during code review.

**Related issues:** #1, #2

## D-004 — postgres-readonly enforces default-deny on writes via DB role + session + SQL parsing (2026-05-15)
**Decision:** The `postgres-readonly` server defends against writes at three independent layers: (1) the connection string points to a role with no write privileges (DB-side), (2) every query runs in a session with `default_transaction_read_only = on` (session-side), and (3) every input to `run_select` passes through a SELECT-only guard that strips comments + string literals, splits on `;` while honoring quoted strings, requires the leading keyword be in a small allow-list, and rejects any forbidden keyword anywhere (statement-side).

**Why:** Defense in depth, because no single layer is sufficient:
- Role-only would allow a *writeable* server if the operator forgets to use the read-only role; the server should refuse to *attempt* a write rather than silently fail at the DB.
- SQL parsing-only is bypassable by any SQL the parser doesn't understand (`WITH x AS (INSERT ... RETURNING ...) SELECT * FROM x`, etc.) — and the more sophisticated the parser, the more attack surface in the parser itself.
- Session-only is bypassable if the role has `BYPASSRLS` or similar.

The composition closes the gaps: even if the role is mis-configured AND the parser misses a clever bypass AND the session attribute is unset, all three would have to fail simultaneously.

**Alternatives considered:**
- Role-only — rejected because it requires perfect operator config.
- SQL parsing-only (e.g., import a full Postgres SQL parser) — rejected as too much attack surface for a one-pattern cookbook entry. The keyword-allow-list approach is small and auditable.
- Prepared-statements filter — rejected because parameterized queries don't help with this threat (the threat is the query text itself, not parameter injection).

**Reversibility:** Cheap. Each layer is independently swappable.

**Related issues:** #1

## D-005 — Allow-list is resolved at construction, not per call (2026-05-16)
**Decision:** The filesystem-sandbox's allow-list paths are resolved to their canonical (symlink-followed) real-paths once, when `Sandbox.create(roots)` is called. Per-call path resolution then compares against those frozen roots.

**Why:** Cheaper (no per-call `realpath` on every root), and locks the set so a mid-run symlink change on a root cannot widen the sandbox. If an operator wants to change the allow-list, they restart the server — the same shape as every other env-var-driven setting in this cookbook.

**Alternatives considered:**
- Resolve on every call — rejected: redundant `realpath` syscalls, plus opens a TOCTOU window if a root is symlinked.
- Watch roots for changes (inotify-style) — rejected: too complex for a cookbook entry; "restart to change config" is the right primitive.

**Reversibility:** Cheap. Move the `realpath` calls from constructor to per-call resolution; the rest of the API is unchanged.

**Related issues:** #2

## D-006 — Path resolution uses `fs.realpath` (follows symlinks), not `path.resolve` alone (2026-05-16)
**Decision:** `Sandbox.resolve(input)` calls `fs.realpath(input)` to get the canonical, symlink-followed real-path before the containment check. `path.resolve` / `path.normalize` alone (which only normalize `..` and `.`) would let a symlink under the allow-list pointing outside it slip through.

**Why:** The sandbox's whole point is to be safe against a misbehaving client. If `allowedRoot/leak → /etc/passwd` slips through because `path.resolve` doesn't dereference symlinks, the entire sandbox is fictional. `fs.realpath` is the right primitive — it's what the OS would dereference at `open()` time, so we're checking *what would actually be touched*, not what the client *typed*.

**Alternatives considered:**
- `path.resolve` only — rejected: doesn't dereference symlinks (the whole concern).
- Parse symlinks manually — rejected: brittle, race-condition prone, and `fs.realpath` exists for exactly this.
- Refuse all symlinks unconditionally — rejected: too restrictive; legitimate setups have symlinked dirs under their workspace (e.g., `node_modules` workspaces).

**Reversibility:** Cheap. One function call swap; the boundary check around it is unchanged.

**Related issues:** #2

## D-007 — Token-bearing servers redact auth at error boundaries; request bodies are dropped from error context (2026-05-16)
**Decision:** Any cookbook server that holds a credential (currently `github-gists`; the API-wrapper pattern in general) follows two rules: (1) the bearer value never appears in any error message, tool result, or log statement that crosses the server's process boundary, and (2) the request body is dropped from error context entirely. Errors that escape the client layer carry the HTTP status, the request path (without query strings), and the upstream-reported `message` field. Nothing else.

**Why:** Token leakage through tool responses is the first failure mode of an API-wrapper server, and the most embarrassing one — a single error returned to an MCP client that happens to forward it to a chat transcript or a PR comment can leak a long-lived PAT. Redacting at the *client* layer (rather than at the tool layer or in a logger filter) means the tool layer never has to be aware of what's secret, which is the only way to make this rule hold under future code changes. Request bodies get the same treatment because they carry user-supplied content (gist descriptions, file contents) that the user wouldn't want appearing in error surfaces either — and once we accept "errors should not contain secrets", "client-supplied content" is the next category that must not leak. This is a sibling rule to D-003's mandatory threat model: defense in depth, made explicit.

**Alternatives considered:**
- Redact in the logger only — rejected: doesn't cover tool results or error messages returned to MCP clients, which is the bigger leakage surface.
- Redact in the tool layer — rejected: pushes secret-awareness outward into every tool, which is exactly the kind of knowledge-leak the client-layer encapsulation should prevent.
- Full request/response logging "for debugging" — rejected: convenience tradeoff that loses in adversarial conditions; the right place to add request inspection is a developer-opt-in flag that isn't on in production.

**Reversibility:** Cheap. The redaction posture lives in two small methods (`request` and `reasonFromResponse` on `GistsClient`); future API wrappers replicate the pattern.

**Related issues:** #3

## D-008 — Canonical SDK version lives in `docs/spec-version.md`; CI script enforces conformance (2026-05-17)
**Decision:** The single source of truth for the pinned `@modelcontextprotocol/sdk` version is `docs/spec-version.md`. It carries a fenced YAML block with `sdk_package`, `sdk_version`, `mcp_spec_revision`, the upstream spec URL, and the bump procedure. `tools/check-spec-version.mjs` (dep-free Node stdlib) parses that block at CI time and asserts every `servers/*/package.json` declares the SDK at the documented version, and that all servers pin the same value.

**Why:** Two structural facts force the design. First, the cookbook is "per-server independence" (D-002) — there's no root `package.json` to carry a workspace-level dependency pin, so the cross-server invariant can't be expressed in code without inventing a layer the cookbook explicitly avoided. Second, the *purpose* of the pin is reviewer-visible. A drift between the doc and `package.json` is exactly what a reviewer should be able to see at a glance, which is why the doc is markdown rather than another JSON file: when an SDK bump lands, the operator updates the doc *and* every server in one PR, and the reviewer reads the doc's bump procedure section to understand what changed. The CI script catches drift between the two; an operator who forgets one or the other gets a loud failure with the filename. Upstream verification against modelcontextprotocol.io is left as a manual step in the bump procedure (CI doesn't reach the network) because the spec changes slowly enough that automating it would buy DNS flakes more often than it would buy a real signal.

**Alternatives considered:**
- Read from one designated server's `package.json` and broadcast — rejected: silos the cross-server decision in a code file, hostile to reviewers, and creates an asymmetry where one server is "blessed" while others are "downstream."
- Per-server declarations + CI script reconciles — rejected: no single owner of the invariant, harder to bump (operator has to remember every file).
- Online check against modelcontextprotocol.io — rejected: makes CI depend on third-party DNS + uptime + throttling for a check that needs to be deterministic.

**Reversibility:** Cheap. The doc parser is ~25 lines; if the doc grows past the fixed-shape five-line block, swap in `yaml` from npm and update the tests. The script's two invariants are pure functions and exposed for testing.

**Related issues:** #6

## D-009 — `internal-tools-bridge` uses shell-free spawn with allowlist, env scrub, output cap, and timeout — structured args only (2026-05-18)

**Decision:** The `internal-tools-bridge` server invokes its bundled CLI via `child_process.spawn` with `shell: false`, passing args as an array. The binary must be in an explicit absolute-path allowlist (default: `process.execPath` only). The environment is scrubbed to a documented passlist (`PATH`, `LANG`, `LC_ALL`, `TZ`, `NODE_OPTIONS`). Stdout and stderr are each capped at 1 MiB; the bridge SIGKILLs on a 10-second timeout. The MCP tool's input is structured args validated before the argv array is built, never a raw command string.

**Why:** The bridge pattern's whole job is to expose internal CLIs to an agent without giving the agent a shell. Every layer of the defense matters because each defeats a different attack:

- `shell: false` + array argv means shell metacharacters (`;`, `&&`, `|`, `$()`, `>`) survive as literal data, never as additional commands. The `argv shape > never invokes a shell` test passes those exact tokens through and asserts they reach the child's `argv` verbatim. If a future refactor flips `shell: true`, the test fails.
- The absolute-path allowlist defeats PATH-based attack widening: even if `PATH` were attacker-controlled (it isn't — we scrub env — but the principle is *defense in depth*), the bridge wouldn't run `/tmp/evil/node`. A relative path like `"node"` is also rejected.
- The env scrub defeats secret exfiltration via the child. Node's `spawn` inherits `process.env` by default — the bridge constructs a fresh env containing only the passlist. The `env scrub > does not leak secrets` test plants a sentinel in the parent env and asserts the child reads back `null`.
- The output cap plus timeout means a buggy or hostile CLI can't OOM the server or hang it indefinitely. Both are tested with deliberate violations.
- Validating tool input *before* building the argv array means a malformed input is rejected with a typed `ToolInputError` (which the server's catch turns into an `isError` MCP response) rather than reaching `spawn`. The shape of the validated input — `{ path: string (non-empty, no NUL), max_depth?: integer ∈ [1,10] }` — is a contract callers can rely on.

This is the same defense-in-depth posture used by D-004 (postgres-readonly: no single layer of write-blocking is sufficient) and D-007 (github-gists: redaction at every error boundary). The cookbook's recurring point is that each server's *security pattern* is the load-bearing artifact, not the wrapped tool itself.

**Alternatives considered:**
- `child_process.exec` (string command line, shell-on) — rejected: the shell interprets metacharacters; nonstarter for an LLM-facing bridge.
- No allowlist (rely on the calling code to pass a sensible binary) — rejected: defense-in-depth fails. The bridge becomes a generic shell-equivalent regardless of `shell: false` if any path can be spawned.
- No env scrub (inherit `process.env`) — rejected: host secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, anything sourced from `~/.zshrc`) leak into the child by default. A CLI that prints `process.env` (or one with a bug that does so) becomes a data exfil channel.
- Output cap on stdout only — rejected: a chatty stderr can still OOM the server. Cap both, equally.

**Reversibility:** Cheap. The bridge is one file (`src/bridge.ts`, ~160 lines). Each layer can be relaxed independently if a specific use case demands it, but the *default* must be the tight one — operators who want to loosen explicitly pass a wider `BridgeConfig`.

**Related issues:** #4
