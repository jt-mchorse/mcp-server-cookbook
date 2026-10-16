/**
 * A result column named `__proto__` is a column like any other (#293).
 *
 * pg's object rows assign `row[name] = value`, which for `__proto__` sets the
 * row's prototype. Measured on `main` against PostgreSQL 17.6:
 *   - `SELECT 7 AS id, 'hello'::text AS "__proto__"` -> rows [{ id: 7 }];
 *   - `SELECT 7 AS id, '{"id": 999, "role": "admin"}'::jsonb AS "__proto__"`
 *     -> rows [{ id: 999, role: "admin" }]: the jsonb value replaced the row.
 *
 * Hermetic like the other payload suites: `withClient` is mocked with a client
 * whose `query` builds pg's REAL `Result`, so the row shape is pg's own.
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
  parseRow(r: unknown[]): unknown;
  addRow(r: unknown): void;
};

type Col = { name: string; oid: number };
let nextResult: { cols: Col[]; rows: Array<Array<string | null>> };

vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  withClient: async (_cfg: unknown, fn: (c: unknown) => unknown) =>
    fn({
      query: async (config: string | { text: string; types?: unknown; rowMode?: string }) => {
        if (typeof config === "string") return { fields: [], rows: [] };
        const r = new Result(config.rowMode, config.types);
        r.addFields(nextResult.cols.map((c) => ({ name: c.name, dataTypeID: c.oid, format: "text" })));
        for (const row of nextResult.rows) r.addRow(r.parseRow(row));
        return r;
      },
    }),
}));

const { rowsByName, runSelect, sampleRows } = await import("../src/tools.js");

const CFG = { connectionString: "postgres://x/y", maxRows: 100, statementTimeoutMs: 1000 };
const INT4 = 23;
const TEXT = 25;
const JSONB = 3802;

function rowsOf(r: { content: Array<{ text: string }>; isError?: boolean }): unknown[] {
  expect(r.isError).toBeFalsy();
  return (JSON.parse(r.content[0]!.text) as { rows: unknown[] }).rows;
}

describe("a column named __proto__ (#293)", () => {
  it("run_select keeps a scalar __proto__ value as a key of its row", async () => {
    nextResult = { cols: [{ name: "id", oid: INT4 }, { name: "__proto__", oid: TEXT }], rows: [["7", "hello"]] };
    const rows = rowsOf(await runSelect({ sql: `SELECT 7 AS id, 'hello'::text AS "__proto__"` }, CFG));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] as object)).toEqual(["id", "__proto__"]);
    expect(Object.getOwnPropertyDescriptor(rows[0], "__proto__")?.value).toBe("hello");
  });

  it("run_select: a jsonb __proto__ no longer replaces the row with its own value", async () => {
    nextResult = {
      cols: [{ name: "id", oid: INT4 }, { name: "__proto__", oid: JSONB }],
      rows: [["7", '{"id": 999, "role": "admin"}']],
    };
    const rows = rowsOf(
      await runSelect({ sql: `SELECT 7 AS id, '{"id": 999, "role": "admin"}'::jsonb AS "__proto__"` }, CFG),
    );
    const row = rows[0] as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(["id", "__proto__"]);
    expect(row.id).toBe(7);
    expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toEqual({ id: 999, role: "admin" });
  });

  it("sample_rows keeps a table's __proto__ column", async () => {
    nextResult = { cols: [{ name: "__proto__", oid: INT4 }, { name: "a", oid: INT4 }], rows: [["1", "2"]] };
    const rows = rowsOf(await sampleRows({ table: "t" }, CFG));
    expect(Object.keys(rows[0] as object)).toEqual(["__proto__", "a"]);
    expect(Object.getOwnPropertyDescriptor(rows[0], "__proto__")?.value).toBe(1);
  });

  it("ordinary names keep today's row shape (control)", async () => {
    nextResult = { cols: [{ name: "id", oid: INT4 }, { name: "name", oid: TEXT }], rows: [["7", "ada"], ["8", null]] };
    const rows = rowsOf(await runSelect({ sql: "SELECT id, name FROM users" }, CFG));
    expect(rows).toEqual([{ id: 7, name: "ada" }, { id: 8, name: null }]);
  });

  it("rowsByName makes every Object.prototype name an own key", () => {
    const names = ["__proto__", "constructor", "toString", "hasOwnProperty"];
    const [row] = rowsByName(names.map((name) => ({ name })), [[1, 2, 3, 4]]);
    expect(Object.keys(row!)).toEqual(names);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(row))).toEqual(JSON.parse('{"__proto__":1,"constructor":2,"toString":3,"hasOwnProperty":4}'));
  });
});
