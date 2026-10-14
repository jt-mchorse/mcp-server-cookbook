/**
 * `STATEMENT_TIMEOUT_MS` is refused above what its timers can honour (#277).
 *
 * #229 handed the value to two client-side Node timers: `connectionTimeoutMillis`
 * (`max(value, 5000)`) and `query_timeout` (`value + 1000`). Node clamps any
 * `setTimeout` delay above `2**31 - 1` to 1 ms, so a generous timeout booted
 * fine and then failed every call in ~3 ms as a timeout. github-gists and
 * internal-tools-bridge had refused the same class at boot since #143; this
 * server got its timers later and not the bound.
 */
import { afterEach, describe, expect, it } from "vitest";

import { MAX_STATEMENT_TIMEOUT_MS, readDbConfigFromEnv, validateDbConfig } from "../src/db.js";

const SAVED = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

function fromEnv(raw: string) {
  process.env.DATABASE_URL = "postgres://ro@localhost/db";
  delete process.env.MAX_ROWS;
  process.env.STATEMENT_TIMEOUT_MS = raw;
  return readDbConfigFromEnv();
}

const cfg = (statementTimeoutMs: number) => ({
  connectionString: "postgres://ro@localhost/db",
  maxRows: 10,
  statementTimeoutMs,
});

/** Each measured to fail every call on PostgreSQL 17.6 before #277. */
const OVER = [2147482648, 2147483647, 2147483648, 10_000_000_000, Number.MAX_SAFE_INTEGER] as const;

describe("MAX_STATEMENT_TIMEOUT_MS", () => {
  it("leaves the 1s query backstop inside the 32-bit timer range", () => {
    // Pinned as arithmetic, not a literal: the bound is derived from the
    // `+ 1000` in withClient, and a change there must move it.
    expect(MAX_STATEMENT_TIMEOUT_MS + 1000).toBe(2 ** 31 - 1);
  });
});

describe("STATEMENT_TIMEOUT_MS from the environment", () => {
  it("accepts the bound itself", () => {
    expect(fromEnv(String(MAX_STATEMENT_TIMEOUT_MS)).statementTimeoutMs).toBe(MAX_STATEMENT_TIMEOUT_MS);
  });

  it.each(OVER)("refuses %i, naming the variable, the bound and the value", (n) => {
    expect(() => fromEnv(String(n))).toThrow(
      new RegExp(`STATEMENT_TIMEOUT_MS must be <= ${MAX_STATEMENT_TIMEOUT_MS}[\\s\\S]*got ${n}$`),
    );
  });
});

describe("validateDbConfig", () => {
  it("accepts the bound itself", () => {
    expect(() => validateDbConfig(cfg(MAX_STATEMENT_TIMEOUT_MS))).not.toThrow();
  });

  it.each(OVER)("refuses statementTimeoutMs = %i", (n) => {
    expect(() => validateDbConfig(cfg(n))).toThrow(/statementTimeoutMs must be <= 2147482647/);
  });
});
