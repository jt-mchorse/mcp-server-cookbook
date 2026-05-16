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
