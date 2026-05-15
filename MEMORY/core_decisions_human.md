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
