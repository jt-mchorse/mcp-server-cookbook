/**
 * `json` / `jsonb` reach the payload as the database's own text (#247).
 *
 * Measured on `main` against Postgres 17: pg's default `json`/`jsonb` parser is
 * `JSON.parse`, so `{"id": 12345678901234567891}` came back as
 * `12345678901234567000`, `{"big": 1e400}` (a valid jsonb numeric) as
 * `{"big": "Infinity"}` through #207's non-finite replacer, and a `json` value's
 * repeated key lost one value. The same id in a `numeric` column was exact.
 *
 * Same harness as `run-select-payload-fidelity.test.ts`: `withClient` is mocked
 * with a client whose `query` builds pg's REAL `Result` from the `types` the
 * call site passes. The text-format values below are what Postgres 17 sends.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

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
const JSON_OID = 114;
const JSONB = 3802;
const JSON_ARRAY = 199;
const JSONB_ARRAY = 3807;
const FLOAT8 = 701;

const BIG = '{"id": 12345678901234567891, "big": 1e400, "x": 0.1000000000000000055511151231257827}';

function text(r: { content: Array<{ text: string }>; isError?: boolean }): string {
  expect(r.isError).toBeUndefined();
  return r.content[0]!.text;
}

describe("run_select returns json/jsonb as the database wrote it (#247)", () => {
  it("a big int, 1e400 and a long decimal inside jsonb survive digit for digit", async () => {
    nextResult = { cols: [{ name: "doc", oid: JSONB }], rows: [[BIG]] };
    const out = text(await runSelect({ sql: "SELECT doc FROM t" }, CFG));
    expect(out).toContain(`"doc": ${BIG}`);
    expect(out).not.toContain("12345678901234567000");
    expect(out).not.toContain("Infinity");
  });

  it("a json value keeps both of its repeated keys", async () => {
    nextResult = { cols: [{ name: "d", oid: JSON_OID }], rows: [['{"a":1,"a":2}']] };
    expect(text(await runSelect({ sql: "SELECT d FROM t" }, CFG))).toContain('"d": {"a":1,"a":2}');
  });

  it("jsonb[] keeps each element's text, an escaped quote included, and SQL NULL as null", async () => {
    nextResult = {
      cols: [{ name: "arr", oid: JSONB_ARRAY }],
      rows: [['{"{\\"a\\": \\"x\\\\\\"y,}{\\", \\"n\\": 12345678901234567891}",NULL}']],
    };
    const out = text(await runSelect({ sql: "SELECT arr FROM t" }, CFG));
    expect(out).toContain('{"a": "x\\"y,}{", "n": 12345678901234567891}');
    const arr = JSON.parse(out).rows[0].arr;
    expect(arr).toHaveLength(2);
    expect(arr[0].a).toBe('x"y,}{');
    expect(arr[1]).toBeNull();
  });

  it("a two-dimensional json[] stays nested", async () => {
    nextResult = { cols: [{ name: "md", oid: JSON_ARRAY }], rows: [['{{1,[2]},{"{}","\\"s\\""}}']] };
    const out = text(await runSelect({ sql: "SELECT md FROM t" }, CFG));
    expect(JSON.parse(out).rows[0].md).toEqual([[1, [2]], [{}, "s"]]);
  });

  it("the payload is one JSON document that parses to today's nested shape (control)", async () => {
    nextResult = {
      cols: [
        { name: "doc", oid: JSONB },
        { name: "nul", oid: JSONB },
        { name: "x", oid: FLOAT8 },
      ],
      rows: [
        ['{"k": [1, "two", null, {"z": true}]}', null, "NaN"],
        ['"<\\/script> \\u00e9"', '{"n": 1}', "1.5"],
      ],
    };
    const parsed = JSON.parse(text(await runSelect({ sql: "SELECT doc, nul, x FROM t" }, CFG)));
    expect(parsed.row_count).toBe(2);
    expect(parsed.rows).toEqual([
      { doc: { k: [1, "two", null, { z: true }] }, nul: null, x: "NaN" },
      { doc: "</script> é", nul: { n: 1 }, x: 1.5 },
    ]);
  });

  it("sample_rows gets the same handling", async () => {
    nextResult = { cols: [{ name: "doc", oid: JSONB }], rows: [[BIG]] };
    expect(text(await sampleRows({ table: "t" }, CFG))).toContain(`"doc": ${BIG}`);
  });
});
