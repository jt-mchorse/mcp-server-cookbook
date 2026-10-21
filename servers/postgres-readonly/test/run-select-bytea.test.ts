/**
 * `bytea` and `bytea[]` are returned as the database's text (#315).
 *
 * Measured on `main` e97210b against Postgres 17.6, with
 * `CREATE TABLE blobs(id int, b bytea, j json)` holding
 * `(1, '\x0102', '{"type":"Buffer","data":[1,2]}')`: `sample_rows` and
 * `run_select` both returned `"b":{"type":"Buffer","data":[1,2]}` and
 * `"j":{"type":"Buffer","data":[1,2]}` -- pg's bytea parser makes a Node
 * `Buffer`, and JSON writes a Buffer as exactly that object. A `bytea[]` came
 * back as `[{"type":"Buffer","data":[1]}]`, and a 100,000-byte value as a
 * 1,500,237-character payload against 200,180 for `SELECT b::text`.
 *
 * Same harness as `run-select-unregistered-arrays.test.ts`: `withClient` is
 * mocked with a client whose `query` builds pg's REAL `Result` from the `types`
 * the call site passes. The text values below are what Postgres 17 sends under
 * `bytea_output = hex`, which `withClient` pins (see `session-pins.test.ts`).
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
};

const INT4 = 23;
const BYTEA = 17;
const BYTEA_ARRAY = 1001;
const JSON_OID = 114;

type Col = { name: string; oid: number };
let nextResult: { cols: Col[]; rows: Array<Array<string | null>> };

vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  withClient: async (_cfg: unknown, fn: (c: unknown) => unknown) =>
    fn({
      query: async (config: string | { text: string; types?: unknown; rowMode?: string }) => {
        const c = typeof config === "string" ? { text: config } : config;
        const r = new Result(c.rowMode, c.types);
        r.addFields(nextResult.cols.map((col) => ({ name: col.name, dataTypeID: col.oid, format: "text" })));
        for (const row of nextResult.rows) r.addRow(r.parseRow(row));
        return r;
      },
    }),
}));

const { runSelect, sampleRows } = await import("../src/tools.js");

const CFG = { connectionString: "postgres://x/y", maxRows: 100, statementTimeoutMs: 1000 };

function rows(r: { content: Array<{ text: string }>; isError?: boolean }): Array<Record<string, unknown>> {
  expect(r.isError).toBeUndefined();
  return (JSON.parse(r.content[0]!.text) as { rows: Array<Record<string, unknown>> }).rows;
}

// The issue's table: a bytea, a json control holding a Buffer's JSON shape,
// and a bytea[] with a NULL element; row 2 has the empty bytea and array.
const BLOBS = {
  cols: [
    { name: "id", oid: INT4 },
    { name: "b", oid: BYTEA },
    { name: "j", oid: JSON_OID },
    { name: "ba", oid: BYTEA_ARRAY },
  ],
  rows: [
    ["1", "\\x0102", '{"type":"Buffer","data":[1,2]}', '{"\\\\x01",NULL,"\\\\x"}'],
    ["2", "\\x", null, "{}"],
  ],
};
const EXPECTED = [
  { id: 1, b: "\\x0102", j: { type: "Buffer", data: [1, 2] }, ba: ["\\x01", null, "\\x"] },
  { id: 2, b: "\\x", j: null, ba: [] },
];

describe("bytea keeps the database's hex text (#315)", () => {
  it("run_select: bytea, empty bytea and bytea[] with a NULL, beside a json control", async () => {
    nextResult = BLOBS;
    expect(rows(await runSelect({ sql: "SELECT * FROM blobs" }, CFG))).toEqual(EXPECTED);
  });

  it("sample_rows: the same table", async () => {
    nextResult = BLOBS;
    expect(rows(await sampleRows({ table: "blobs" }, CFG))).toEqual(EXPECTED);
  });

  it("a bytea and a json value of a Buffer's shape are different JSON", async () => {
    nextResult = { cols: BLOBS.cols.slice(1, 3), rows: [BLOBS.rows[0]!.slice(1, 3)] };
    const [row] = rows(await runSelect({ sql: "SELECT b, j FROM blobs" }, CFG));
    expect(row!.b).not.toEqual(row!.j);
  });

  it("a 2-D bytea[] keeps its shape and its NULL", async () => {
    nextResult = { cols: [{ name: "m", oid: BYTEA_ARRAY }], rows: [['{{"\\\\x01"},{NULL}}']] };
    expect(rows(await runSelect({ sql: "SELECT m FROM t" }, CFG))).toEqual([{ m: [["\\x01"], [null]] }]);
  });

  it("a 100,000-byte value's payload is about its hex length, not ~15 characters per byte", async () => {
    const hex = "\\x" + "ab".repeat(100_000);
    nextResult = { cols: [{ name: "b", oid: BYTEA }], rows: [[hex]] };
    const r = await runSelect({ sql: "SELECT b FROM big" }, CFG);
    // JSON doubles the one backslash; the rest is the envelope.
    expect(r.content[0]!.text.length).toBeLessThan(hex.length + 300);
    expect(rows(r)).toEqual([{ b: hex }]);
  });
});

describe("controls: what #315 must leave alone", () => {
  it("a json value of a Buffer's shape is still a nested object", async () => {
    nextResult = { cols: [{ name: "j", oid: JSON_OID }], rows: [['{"type":"Buffer","data":[1,2]}']] };
    expect(rows(await sampleRows({ table: "t" }, CFG))).toEqual([{ j: { type: "Buffer", data: [1, 2] } }]);
  });

  it("a NULL bytea is null, not a string", async () => {
    nextResult = { cols: [{ name: "b", oid: BYTEA }], rows: [[null]] };
    expect(rows(await runSelect({ sql: "SELECT NULL::bytea AS b" }, CFG))).toEqual([{ b: null }]);
  });
});
