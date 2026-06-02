/**
 * Programmatic-entry validation tests for `DbConfig` (#44).
 *
 * Mirrors the per-field gate posture in `internal-tools-bridge`'s
 * `validateConfig(cfg: BridgeConfig)` (D-009). Each silent-degeneracy
 * shape is exercised against `validateDbConfig` directly so the
 * documented gap (statement_timeout = 0 silently disables timeout;
 * maxRows = 0 silently empties result sets) cannot regress.
 *
 * `withClient` integration is exercised in the negative direction
 * only (gate raises before any pg client is constructed) so the test
 * suite stays hermetic — no real Postgres needed.
 */

import { describe, expect, it } from "vitest";

import { type DbConfig, readDbConfigFromEnv, validateDbConfig, withClient } from "../src/db.js";

function makeValidConfig(overrides: Partial<DbConfig> = {}): DbConfig {
  return {
    connectionString: "postgresql://reader:reader@localhost:5432/test",
    maxRows: 1000,
    statementTimeoutMs: 5000,
    ...overrides,
  };
}

describe("validateDbConfig — connectionString", () => {
  it("accepts a well-formed connection string", () => {
    expect(() => validateDbConfig(makeValidConfig())).not.toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => validateDbConfig(makeValidConfig({ connectionString: "" }))).toThrow(
      /connectionString must be a non-empty string/,
    );
  });

  it("rejects a non-string", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateDbConfig(makeValidConfig({ connectionString: 42 as any })),
    ).toThrow(/connectionString must be a non-empty string/);
  });
});

describe("validateDbConfig — maxRows", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s", (_label, bad) => {
    expect(() => validateDbConfig(makeValidConfig({ maxRows: bad }))).toThrow(
      /maxRows must be an integer >= 1/,
    );
  });

  it.each([
    ["a non-number", "1000"],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
  ])("rejects %s", (_label, bad) => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateDbConfig(makeValidConfig({ maxRows: bad as any })),
    ).toThrow(/maxRows must be an integer >= 1/);
  });

  it("accepts 1 as the minimum", () => {
    expect(() => validateDbConfig(makeValidConfig({ maxRows: 1 }))).not.toThrow();
  });
});

describe("validateDbConfig — statementTimeoutMs", () => {
  it.each([
    ["zero (which Postgres treats as no-timeout)", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s", (_label, bad) => {
    expect(() => validateDbConfig(makeValidConfig({ statementTimeoutMs: bad }))).toThrow(
      /statementTimeoutMs must be an integer >= 1/,
    );
  });

  it("error message names Postgres's 0 = no-timeout semantics", () => {
    // Operators reading the message should understand WHY 0 is rejected,
    // not just THAT it is. Locks the documented rationale into the
    // user-visible string.
    expect(() => validateDbConfig(makeValidConfig({ statementTimeoutMs: 0 }))).toThrow(
      /statement_timeout = 0 means no timeout/,
    );
  });

  it("accepts 1 as the minimum", () => {
    expect(() => validateDbConfig(makeValidConfig({ statementTimeoutMs: 1 }))).not.toThrow();
  });
});

describe("validateDbConfig — env-loaded config round-trips through the gate", () => {
  // Acceptance regression: a `DbConfig` produced by `readDbConfigFromEnv`
  // must satisfy `validateDbConfig` so existing env-loaded callers
  // don't pay a new throw on the happy path.
  it("env-loaded config validates clean", () => {
    const savedUrl = process.env.DATABASE_URL;
    const savedMaxRows = process.env.MAX_ROWS;
    const savedTimeout = process.env.STATEMENT_TIMEOUT_MS;
    try {
      process.env.DATABASE_URL = "postgresql://reader:reader@localhost:5432/test";
      process.env.MAX_ROWS = "500";
      process.env.STATEMENT_TIMEOUT_MS = "2500";
      const cfg = readDbConfigFromEnv();
      expect(() => validateDbConfig(cfg)).not.toThrow();
      expect(cfg.maxRows).toBe(500);
      expect(cfg.statementTimeoutMs).toBe(2500);
    } finally {
      if (savedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedUrl;
      if (savedMaxRows === undefined) delete process.env.MAX_ROWS;
      else process.env.MAX_ROWS = savedMaxRows;
      if (savedTimeout === undefined) delete process.env.STATEMENT_TIMEOUT_MS;
      else process.env.STATEMENT_TIMEOUT_MS = savedTimeout;
    }
  });
});

describe("withClient — programmatic-entry gate fires before pg client construction", () => {
  it("rejects a bad config before any DB I/O", async () => {
    // No real DB available in this test environment; the assertion is
    // that the gate raises *before* `new Client(...)` is ever called,
    // so no network attempt is made. If the gate were missing, this
    // would try to connect and either time out or surface a
    // connection error — both noisier than the documented programmatic
    // contract failure.
    await expect(
      withClient(
        { connectionString: "postgresql://reader:reader@localhost:5432/test", maxRows: 0, statementTimeoutMs: 5000 },
        async () => "should not run",
      ),
    ).rejects.toThrow(/maxRows must be an integer >= 1/);
  });

  it("rejects a 0 statementTimeoutMs before any SET statement_timeout = 0 is issued", async () => {
    await expect(
      withClient(
        {
          connectionString: "postgresql://reader:reader@localhost:5432/test",
          maxRows: 1000,
          statementTimeoutMs: 0,
        },
        async () => "should not run",
      ),
    ).rejects.toThrow(/statement_timeout = 0 means no timeout/);
  });
});
