/**
 * `timestamptz` keeps every instant Postgres can hold (#249).
 *
 * Measured on `main` against Postgres 17: `.123456` and `.123999` both came
 * back as `"2024-01-01T00:00:00.123Z"`, and `294276-12-31 23:59:59+00` (inside
 * Postgres's range, past `Date`'s) as `null`, the same as SQL NULL.
 *
 * Same harness as `run-select-payload-fidelity.test.ts`: `withClient` is mocked
 * with a client whose `query` builds pg's REAL `Result` from the `types` the
 * call site passes. The text values are what Postgres 17 sends with the
 * session time zone set to Asia/Kolkata, LMT offsets with seconds included.
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

const { runSelect, sampleRows } = await import("../src/tools.js");

const CFG = { connectionString: "postgres://x/y", maxRows: 100, statementTimeoutMs: 1000 };
const TIMESTAMPTZ = 1184;
const TIMESTAMPTZ_ARRAY = 1185;

function rows(r: { content: Array<{ text: string }>; isError?: boolean }): Array<Record<string, unknown>> {
  expect(r.isError).toBeUndefined();
  return (JSON.parse(r.content[0]!.text) as { rows: Array<Record<string, unknown>> }).rows;
}

let savedTz: string | undefined;
beforeEach(() => {
  savedTz = process.env.TZ;
});
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe.each(["UTC", "America/Los_Angeles"])("run_select timestamptz under TZ=%s (#249)", (tz) => {
  it("keeps the database's microseconds, so two distinct instants stay distinct", async () => {
    process.env.TZ = tz;
    nextResult = {
      cols: [{ name: "a", oid: TIMESTAMPTZ }, { name: "b", oid: TIMESTAMPTZ }],
      rows: [["2024-01-01 05:30:00.123456+05:30", "2024-01-01 05:30:00.123999+05:30"]],
    };
    const [row] = rows(await runSelect({ sql: "SELECT a, b FROM t" }, CFG));
    expect(row).toEqual({ a: "2024-01-01T00:00:00.123456Z", b: "2024-01-01T00:00:00.123999Z" });
  });

  it("returns a year past Date's range as the database's text, not null", async () => {
    process.env.TZ = tz;
    nextResult = { cols: [{ name: "far", oid: TIMESTAMPTZ }], rows: [["294277-01-01 05:29:59+05:30"]] };
    const [row] = rows(await runSelect({ sql: "SELECT far FROM t" }, CFG));
    expect(row!.far).toBe("294277-01-01 05:29:59+05:30");
  });

  it("an LMT offset with seconds and a two-digit year keep their microsecond", async () => {
    process.env.TZ = tz;
    nextResult = {
      cols: [{ name: "a", oid: TIMESTAMPTZ }, { name: "b", oid: TIMESTAMPTZ }],
      rows: [["1900-01-01 05:21:10.000001+05:21:10", "0099-06-01 05:53:28.000001+05:53:28"]],
    };
    const [row] = rows(await runSelect({ sql: "SELECT a, b FROM t" }, CFG));
    expect(row).toEqual({ a: "1900-01-01T00:00:00.000001Z", b: "0099-06-01T00:00:00.000001Z" });
  });

  it("timestamptz[] gets the same per element; NULL and infinity are unchanged", async () => {
    process.env.TZ = tz;
    nextResult = {
      cols: [{ name: "ts", oid: TIMESTAMPTZ_ARRAY }],
      rows: [['{"2024-01-01 05:30:00.123456+05:30","294277-01-01 05:29:59+05:30",NULL,infinity}']],
    };
    const [row] = rows(await runSelect({ sql: "SELECT ts FROM t" }, CFG));
    expect(row!.ts).toEqual(["2024-01-01T00:00:00.123456Z", "294277-01-01 05:29:59+05:30", null, "Infinity"]);
  });
});

describe("timestamptz output that was already exact is byte-identical (control, #249)", () => {
  it("millisecond-or-coarser precision, ±infinity and SQL NULL", async () => {
    nextResult = {
      cols: [{ name: "x", oid: TIMESTAMPTZ }],
      rows: [["2024-01-01 05:30:00+05:30"], ["2024-01-01 05:30:00.1+05:30"], ["infinity"], ["-infinity"], [null]],
    };
    const out = rows(await runSelect({ sql: "SELECT x FROM t" }, CFG)).map((r) => r.x);
    expect(out).toEqual(["2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.100Z", "Infinity", "-Infinity", null]);
  });

  it("sample_rows gets the same handling", async () => {
    nextResult = { cols: [{ name: "a", oid: TIMESTAMPTZ }], rows: [["2024-01-01 05:30:00.123456+05:30"]] };
    expect(rows(await sampleRows({ table: "t" }, CFG))[0]!.a).toBe("2024-01-01T00:00:00.123456Z");
  });
});
