/**
 * Arrays whose element type has no pg-types parser are returned as arrays (#308).
 *
 * Measured on `main` 8897182 against Postgres 17.6: pg-types 2.2.0 parses 28 of
 * PostgreSQL 17's 296 array types, and the rest came back as ONE string in
 * array-literal form -- an enum `mood[]` `{happy,sad}` read the same as the
 * text value '{happy,sad}', `current_schemas(true)` (a `name[]`) as
 * "{pg_catalog,public}", `array[int4range(1,3)]` as "{\"[1,3)\"}",
 * `array['a'::"char"]` as "{a}" and `array[B'101']` as "{101}".
 *
 * Same harness as `run-select-json-fidelity.test.ts`: `withClient` is mocked
 * with a client whose `query` builds pg's REAL `Result` from the `types` the
 * call site passes. The array-ness lookup is answered from `ARRAY_TYPES`, which
 * stands in for `pg_type.typarray` and the element type's `typdelim` -- the
 * text values below are what Postgres 17 sends.
 *
 * #311: #310 split every such array on a comma, but `box` (typdelim `;`) prints
 * `{(1,1),(0,0);(3,3),(2,2)}`, and on main 62644b3 against Postgres 17.6
 * `SELECT array[box '((1,1),(0,0))', box '((3,3),(2,2))']` came back as
 * ["(1","1)","(0","0);(3","3)","(2","2)"] through both run_select and
 * sample_rows. Before #310 it was the database's text, and it is again.
 */
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const TEXT = 25;
const INT4 = 23;
const INT2VECTOR = 22;
const OIDVECTOR = 30;
const TEXT_ARRAY = 1009;
const INT4_ARRAY = 1007;
const NAME_ARRAY = 1003;
const CHAR_ARRAY = 1002;
const BIT_ARRAY = 1561;
const INT4RANGE_ARRAY = 3905;
const POINT_ARRAY = 1017;
// `_box`: its element type `box` is the one built-in type whose typdelim is `;`.
const BOX_ARRAY = 1020;
// A user-defined base type may set its own DELIMITER; any non-comma counts.
const PIPE_DELIM_ARRAY = 16400;
// `create type mood as enum(...)` in a fresh database: the enum is 16384 and
// its array 16389 on Postgres 17; any oid past FirstNormalObjectId will do.
const MOOD_ARRAY = 16389;

// Every type above that is some type's `typarray`, with its element type's
// `typdelim`. int2vector/oidvector are nobody's `typarray`.
const ARRAY_TYPES = new Map<number, string>([
  ...[TEXT_ARRAY, INT4_ARRAY, NAME_ARRAY, CHAR_ARRAY, BIT_ARRAY, INT4RANGE_ARRAY, MOOD_ARRAY, POINT_ARRAY].map(
    (oid): [number, string] => [oid, ","],
  ),
  [BOX_ARRAY, ";"],
  [PIPE_DELIM_ARRAY, "|"],
]);

type Col = { name: string; oid: number };
let nextResult: { cols: Col[]; rows: Array<Array<string | null>> };
let catalogLookups: number[][];
let catalogFails: boolean;

vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  withClient: async (_cfg: unknown, fn: (c: unknown) => unknown) =>
    fn({
      query: async (config: string | { text: string; types?: unknown; rowMode?: string; values?: unknown[] }) => {
        if (typeof config === "object" && config.text.includes("pg_type")) {
          if (catalogFails) throw new Error("canceling statement due to statement timeout");
          const asked = config.values![0] as number[];
          catalogLookups.push(asked);
          return {
            rows: asked.filter((o) => ARRAY_TYPES.has(o)).map((oid) => ({ oid, typdelim: ARRAY_TYPES.get(oid) })),
          };
        }
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

beforeEach(() => {
  catalogLookups = [];
  catalogFails = false;
});

describe("arrays of an element type pg-types does not parse come back as arrays (#308)", () => {
  it("an enum array is an array, distinct from text holding the same literal", async () => {
    nextResult = {
      cols: [
        { name: "moods", oid: MOOD_ARRAY },
        { name: "label", oid: TEXT },
      ],
      rows: [["{happy,sad}", "{happy,sad}"]],
    };
    expect(rows(await runSelect({ sql: "SELECT moods, label FROM t" }, CFG))).toEqual([
      { moods: ["happy", "sad"], label: "{happy,sad}" },
    ]);
  });

  it("name[] -- current_schemas(true)", async () => {
    nextResult = { cols: [{ name: "s", oid: NAME_ARRAY }], rows: [["{pg_catalog,public}"]] };
    expect(rows(await runSelect({ sql: "SELECT current_schemas(true) s" }, CFG))).toEqual([
      { s: ["pg_catalog", "public"] },
    ]);
  });

  it("a range array keeps each range as the database's text", async () => {
    nextResult = { cols: [{ name: "r", oid: INT4RANGE_ARRAY }], rows: [['{"[1,3)",empty}']] };
    expect(rows(await runSelect({ sql: "SELECT array[int4range(1,3), 'empty'] r" }, CFG))).toEqual([
      { r: ["[1,3)", "empty"] },
    ]);
  });

  it('"char"[]', async () => {
    nextResult = { cols: [{ name: "c", oid: CHAR_ARRAY }], rows: [["{a,b}"]] };
    expect(rows(await runSelect({ sql: `SELECT array['a'::"char", 'b'] c` }, CFG))).toEqual([{ c: ["a", "b"] }]);
  });

  it("bit[]", async () => {
    nextResult = { cols: [{ name: "b", oid: BIT_ARRAY }], rows: [["{101,010}"]] };
    expect(rows(await runSelect({ sql: "SELECT array[B'101', B'010'] b" }, CFG))).toEqual([{ b: ["101", "010"] }]);
  });

  it("a 2-D array with a NULL element, and a non-default lower bound, parse as text[] does", async () => {
    nextResult = {
      cols: [
        { name: "m", oid: NAME_ARRAY },
        { name: "lb", oid: NAME_ARRAY },
      ],
      rows: [["{{a,b},{c,NULL}}", "[2:3]={a,b}"]],
    };
    expect(rows(await runSelect({ sql: "SELECT m, lb FROM t" }, CFG))).toEqual([
      {
        m: [
          ["a", "b"],
          ["c", null],
        ],
        lb: ["a", "b"],
      },
    ]);
  });

  it("sample_rows gets the same handling (the issue's table)", async () => {
    nextResult = {
      cols: [
        { name: "id", oid: INT4 },
        { name: "moods", oid: MOOD_ARRAY },
        { name: "tags", oid: TEXT_ARRAY },
        { name: "names", oid: NAME_ARRAY },
      ],
      rows: [
        ["1", "{happy,sad}", "{happy,sad}", "{happy,sad}"],
        ["2", null, '{"{happy,sad}"}', null],
      ],
    };
    expect(rows(await sampleRows({ table: "t" }, CFG))).toEqual([
      { id: 1, moods: ["happy", "sad"], tags: ["happy", "sad"], names: ["happy", "sad"] },
      { id: 2, moods: null, tags: ["{happy,sad}"], names: null },
    ]);
  });

  it("a failed array-type lookup is reported, not swallowed into the old string", async () => {
    catalogFails = true;
    nextResult = { cols: [{ name: "moods", oid: MOOD_ARRAY }], rows: [["{happy,sad}"]] };
    const r = await runSelect({ sql: "SELECT moods FROM t" }, CFG);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("statement timeout");
  });
});

describe("an array whose element type's delimiter is not a comma keeps the database's text (#311)", () => {
  const BOXES = "{(1,1),(0,0);(3,3),(2,2)}";

  it("box[] through run_select", async () => {
    nextResult = { cols: [{ name: "b", oid: BOX_ARRAY }], rows: [[BOXES]] };
    expect(
      rows(await runSelect({ sql: "SELECT array[box '((1,1),(0,0))', box '((3,3),(2,2))'] AS b" }, CFG)),
    ).toEqual([{ b: BOXES }]);
  });

  it("box[] through sample_rows, beside a comma-delimited array that is still parsed", async () => {
    nextResult = {
      cols: [
        { name: "b", oid: BOX_ARRAY },
        { name: "moods", oid: MOOD_ARRAY },
      ],
      rows: [[BOXES, "{happy,sad}"]],
    };
    expect(rows(await sampleRows({ table: "t" }, CFG))).toEqual([{ b: BOXES, moods: ["happy", "sad"] }]);
  });

  it("any other non-comma typdelim (a user-defined base type's DELIMITER)", async () => {
    nextResult = { cols: [{ name: "u", oid: PIPE_DELIM_ARRAY }], rows: [["{a,b|c,d}"]] };
    expect(rows(await runSelect({ sql: "SELECT u FROM t" }, CFG))).toEqual([{ u: "{a,b|c,d}" }]);
  });
});

describe("controls: what #308 must leave alone", () => {
  it("point[] keeps pg's own parser, with no catalog lookup (#311 control)", async () => {
    nextResult = { cols: [{ name: "p", oid: POINT_ARRAY }], rows: [['{"(1,2)","(3,4)"}']] };
    expect(rows(await runSelect({ sql: "SELECT array[point '(1,2)', point '(3,4)'] AS p" }, CFG))).toEqual([
      {
        p: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
    ]);
    expect(catalogLookups).toEqual([]);
  });

  it("text[] and int[] keep pg's own parsers, with no catalog lookup", async () => {
    nextResult = {
      cols: [
        { name: "t", oid: TEXT_ARRAY },
        { name: "i", oid: INT4_ARRAY },
      ],
      rows: [['{x,"{y}"}', "{1,2}"]],
    };
    expect(rows(await runSelect({ sql: "SELECT t, i FROM t" }, CFG))).toEqual([{ t: ["x", "{y}"], i: [1, 2] }]);
    expect(catalogLookups).toEqual([]);
  });

  it("a text value that looks like an array literal stays a string", async () => {
    nextResult = { cols: [{ name: "label", oid: TEXT }], rows: [["{happy,sad}"], ['[1,2]']] };
    expect(rows(await runSelect({ sql: "SELECT label FROM t" }, CFG))).toEqual([
      { label: "{happy,sad}" },
      { label: "[1,2]" },
    ]);
  });

  it("int2vector and oidvector (typcategory 'A', space-separated) stay strings", async () => {
    nextResult = {
      cols: [
        { name: "k", oid: INT2VECTOR },
        { name: "o", oid: OIDVECTOR },
      ],
      rows: [["1 2", "23 25"]],
    };
    expect(rows(await runSelect({ sql: "SELECT indkey k, proargtypes o FROM t" }, CFG))).toEqual([
      { k: "1 2", o: "23 25" },
    ]);
  });

  it("a result with no value that can be an array literal costs no lookup", async () => {
    nextResult = {
      cols: [
        { name: "label", oid: TEXT },
        { name: "moods", oid: MOOD_ARRAY },
      ],
      rows: [
        ["plain", null],
        ["text", null],
      ],
    };
    expect(rows(await runSelect({ sql: "SELECT label, moods FROM t" }, CFG))).toEqual([
      { label: "plain", moods: null },
      { label: "text", moods: null },
    ]);
    expect(catalogLookups).toEqual([]);
  });
});
