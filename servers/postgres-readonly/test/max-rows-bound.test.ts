/**
 * `MAX_ROWS` is refused above what the cursor's FETCH can carry (#280).
 *
 * #256 made `run_select` fetch through a cursor, `FETCH FORWARD <MAX_ROWS + 1>`,
 * and Postgres reads a FETCH count as a 32-bit integer. `parseIntEnv` bounds at
 * MAX_SAFE_INTEGER, so `MAX_ROWS=2147483647` booted and then every `run_select`
 * failed with `syntax error at or near "2147483648"` (measured on PostgreSQL
 * 17.6). The #277 shape, on the server's other integer setting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const issued: string[] = [];

vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  withClient: async (_cfg: unknown, fn: (c: unknown) => unknown) =>
    fn({
      query: async (q: string | { text: string }) => {
        issued.push(typeof q === "string" ? q : q.text);
        return { fields: [], rows: [] };
      },
    }),
}));

const { MAX_MAX_ROWS, readDbConfigFromEnv, validateDbConfig } = await import("../src/db.js");
const { runSelect } = await import("../src/tools.js");

const SAVED = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  issued.length = 0;
});

function fromEnv(raw: string) {
  process.env.DATABASE_URL = "postgres://ro@localhost/db";
  delete process.env.STATEMENT_TIMEOUT_MS;
  process.env.MAX_ROWS = raw;
  return readDbConfigFromEnv();
}

const cfg = (maxRows: number) => ({
  connectionString: "postgres://ro@localhost/db",
  maxRows,
  statementTimeoutMs: 1000,
});

/** Each measured to fail every run_select on PostgreSQL 17.6 before #280. */
const OVER = [2147483647, 2147483648, 4294967295, Number.MAX_SAFE_INTEGER] as const;

const INT32_MAX = 2 ** 31 - 1;

describe("MAX_MAX_ROWS", () => {
  it("leaves the extra truncation row inside Postgres's 32-bit FETCH count", () => {
    // Pinned as arithmetic, not a literal: the bound is derived from the
    // `+ 1` in runSelect, and a change there must move it.
    expect(MAX_MAX_ROWS + 1).toBe(INT32_MAX);
  });

  it("at the bound, run_select sends the largest FETCH count Postgres parses", async () => {
    await runSelect({ sql: "SELECT 1" }, cfg(MAX_MAX_ROWS));
    const fetch = issued.find((q) => q.startsWith("FETCH"));
    const n = Number(/^FETCH FORWARD (\d+) /.exec(fetch ?? "")?.[1]);
    expect(n).toBe(INT32_MAX);
  });
});

describe("MAX_ROWS from the environment", () => {
  it("accepts the bound itself", () => {
    expect(fromEnv(String(MAX_MAX_ROWS)).maxRows).toBe(MAX_MAX_ROWS);
  });

  it.each(OVER)("refuses %i, naming the variable, the bound and the value", (n) => {
    expect(() => fromEnv(String(n))).toThrow(new RegExp(`MAX_ROWS must be <= ${MAX_MAX_ROWS}[\\s\\S]*got ${n}$`));
  });
});

describe("validateDbConfig", () => {
  it("accepts the bound itself", () => {
    expect(() => validateDbConfig(cfg(MAX_MAX_ROWS))).not.toThrow();
  });

  it.each(OVER)("refuses maxRows = %i", (n) => {
    expect(() => validateDbConfig(cfg(n))).toThrow(/maxRows must be <= 2147483646/);
  });
});
