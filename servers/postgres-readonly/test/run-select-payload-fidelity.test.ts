/**
 * `run_select` / `sample_rows` return what the database returned (#207).
 *
 * Measured on `main` through pg's own result parsing:
 *   - `SELECT u.id, o.id ...` -> fields [id, id], rows [{ id: 1001 }] (u.id lost);
 *   - `date '2024-01-01'` -> "2024-01-01T00:00:00.000Z" under TZ=UTC but
 *     "2023-12-31T23:00:00.000Z" under TZ=Europe/Berlin;
 *   - float8 NaN / Infinity -> null, indistinguishable from SQL NULL.
 *
 * The suite is hermetic, so `withClient` is mocked with a client whose `query`
 * builds pg's REAL `Result` from the `types` the call site passes -- which is
 * what tests that the tools pass `SELECT_TYPES` at all.
 */
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
// pg's own row parser; no typings for this internal module.
const Result = require("pg/lib/result.js") as new (
  rowMode: unknown,
  types: unknown,
) => {
  addFields(f: unknown[]): void;
  parseRow(r: unknown[]): Record<string, unknown>;
  addRow(r: unknown): void;
  rows: unknown[];
  fields: Array<{ name: string; dataTypeID: number }>;
};

type Col = { name: string; oid: number };
let nextResult: { cols: Col[]; rows: Array<Array<string | null>> };

vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  withClient: async (_cfg: unknown, fn: (c: unknown) => unknown) =>
    fn({
      query: async (config: { text: string; types?: unknown }) => {
        const r = new Result(undefined, config.types);
        r.addFields(nextResult.cols.map((c) => ({ name: c.name, dataTypeID: c.oid, format: "text" })));
        for (const row of nextResult.rows) r.addRow(r.parseRow(row));
        return r;
      },
    }),
}));

const { runSelect, sampleRows, SELECT_TYPES } = await import("../src/tools.js");

const CFG = { connectionString: "postgres://x/y", maxRows: 100, statementTimeoutMs: 1000 };
const INT4 = 23;
const DATE = 1082;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;
const FLOAT8 = 701;
const DATE_ARRAY = 1182;

function parse(r: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(r.content[0]!.text) as { rows: Array<Record<string, unknown>>; fields: unknown[] };
}

let savedTz: string | undefined;
beforeEach(() => {
  savedTz = process.env.TZ;
});
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("run_select payload fidelity (#207)", () => {
  it("refuses duplicate output column names instead of dropping a value", async () => {
    nextResult = { cols: [{ name: "id", oid: INT4 }, { name: "id", oid: INT4 }], rows: [["7", "1001"]] };
    const r = await runSelect({ sql: "SELECT u.id, o.id FROM users u JOIN orders o ON o.user_id = u.id" }, CFG);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('more than one column named "id"');
    expect(r.content[0]!.text).toContain("AS user_id");
  });

  it("unique names keep the object row shape (control)", async () => {
    nextResult = { cols: [{ name: "user_id", oid: INT4 }, { name: "order_id", oid: INT4 }], rows: [["7", "1001"]] };
    const r = await runSelect({ sql: "SELECT u.id AS user_id, o.id AS order_id FROM users u, orders o" }, CFG);
    expect(r.isError).toBeUndefined();
    expect(parse(r).rows).toEqual([{ user_id: 7, order_id: 1001 }]);
  });

  it.each(["UTC", "Europe/Berlin", "America/Los_Angeles"])(
    "date and timestamp come back as the database's text under TZ=%s",
    async (tz) => {
      process.env.TZ = tz;
      nextResult = {
        cols: [
          { name: "d", oid: DATE },
          { name: "ts", oid: TIMESTAMP },
          { name: "ds", oid: DATE_ARRAY },
        ],
        rows: [["2024-01-01", "2024-01-01 00:00:00", "{2024-01-01,2024-02-29}"]],
      };
      const row = parse(await runSelect({ sql: "SELECT d, ts, ds FROM t" }, CFG)).rows[0]!;
      expect(row).toEqual({ d: "2024-01-01", ts: "2024-01-01 00:00:00", ds: ["2024-01-01", "2024-02-29"] });
    },
  );

  it("timestamptz keeps pg's instant parsing (control)", async () => {
    nextResult = { cols: [{ name: "at", oid: TIMESTAMPTZ }], rows: [["2024-01-01 00:00:00+00"]] };
    const row = parse(await runSelect({ sql: "SELECT at FROM t" }, CFG)).rows[0]!;
    expect(row.at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("non-finite floats are written by name, not as null; SQL NULL stays null", async () => {
    nextResult = { cols: [{ name: "x", oid: FLOAT8 }], rows: [["NaN"], ["Infinity"], ["-Infinity"], [null], ["1.5"]] };
    const rows = parse(await runSelect({ sql: "SELECT x FROM t" }, CFG)).rows;
    expect(rows.map((r) => r.x)).toEqual(["NaN", "Infinity", "-Infinity", null, 1.5]);
  });

  it("sample_rows gets the same date and non-finite handling", async () => {
    process.env.TZ = "Europe/Berlin";
    nextResult = { cols: [{ name: "d", oid: DATE }, { name: "x", oid: FLOAT8 }], rows: [["2024-01-01", "NaN"]] };
    const row = parse(await sampleRows({ table: "t" }, CFG)).rows[0]!;
    expect(row).toEqual({ d: "2024-01-01", x: "NaN" });
  });

  it("SELECT_TYPES defers to pg for every other type (control)", () => {
    expect(SELECT_TYPES.getTypeParser(INT4)("42")).toBe(42);
  });
});
