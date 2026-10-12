/**
 * `run_select` fetches at most MAX_ROWS + 1 rows through a cursor (#256).
 *
 * It ran the query with a plain `c.query`, which materialised every row in
 * this process, and truncated afterwards. Measured on Postgres 17.6 with
 * maxRows=10: `SELECT g, repeat('x',1000) FROM generate_series(1,400000) g`
 * took the server from 86 MB to a 629 MB peak (656 ms) to return 10 rows; with
 * the cursor, 86 MB and 32 ms.
 *
 * The suite is hermetic, so `withClient` hands `runSelect` a recording client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const issued: string[] = [];
let rowsToReturn = 0;
let failOn: string | undefined;

vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  withClient: async (_cfg: unknown, fn: (c: unknown) => unknown) =>
    fn({
      query: async (q: string | { text: string }) => {
        const text = typeof q === "string" ? q : q.text;
        issued.push(text);
        if (failOn !== undefined && text.startsWith(failOn)) throw new Error(`boom at ${failOn}`);
        const isData = text.startsWith("FETCH") || text.startsWith("EXPLAIN");
        const n = isData ? rowsToReturn : 0;
        return {
          fields: isData ? [{ name: "g", dataTypeID: 23 }] : [],
          rows: Array.from({ length: n }, (_, i) => ({ g: i + 1 })),
        };
      },
    }),
}));

const { runSelect } = await import("../src/tools.js");

const CFG = { connectionString: "postgres://x/y", maxRows: 10, statementTimeoutMs: 1000 };

function payload(r: { content: Array<{ text: string }>; isError?: boolean }) {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as { row_count: number; truncated: boolean; max_rows: number };
}

beforeEach(() => {
  issued.length = 0;
  rowsToReturn = 0;
  failOn = undefined;
});

describe("run_select reads through a cursor (#256)", () => {
  it.each([
    "SELECT g FROM generate_series(1, 400000) g",
    "WITH t AS (SELECT 1 AS g) SELECT g FROM t",
    "VALUES (1), (2)",
    "TABLE pg_am",
    "/* lead */ SELECT 1",
  ])("runs %s unchanged as the cursor body and fetches max_rows + 1", async (sql) => {
    rowsToReturn = 3;
    await runSelect({ sql }, CFG);
    expect(issued).toEqual([
      "BEGIN",
      `DECLARE mcp_run_select NO SCROLL CURSOR FOR ${sql}`,
      "FETCH FORWARD 11 FROM mcp_run_select",
      "COMMIT",
    ]);
  });

  it("reports truncated from the one extra row the cursor returned", async () => {
    rowsToReturn = 11;
    const p = payload(await runSelect({ sql: "SELECT 1" }, CFG));
    expect(p).toMatchObject({ row_count: 10, truncated: true, max_rows: 10 });
  });

  it("is not truncated at exactly max_rows", async () => {
    rowsToReturn = 10;
    expect(payload(await runSelect({ sql: "SELECT 1" }, CFG))).toMatchObject({ row_count: 10, truncated: false });
  });

  it("the fetch count follows MAX_ROWS", async () => {
    await runSelect({ sql: "SELECT 1" }, { ...CFG, maxRows: 1 });
    expect(issued).toContain("FETCH FORWARD 2 FROM mcp_run_select");
  });

  it.each(["EXPLAIN SELECT 1", "explain (format json) SELECT 1", "-- why\nEXPLAIN SELECT 1"])(
    "%s keeps the plain path (a plan is not a cursor body)",
    async (sql) => {
      rowsToReturn = 1;
      payload(await runSelect({ sql }, CFG));
      expect(issued).toEqual([sql]);
    },
  );

  it.each(["DECLARE", "FETCH"])("an error at %s is the usual query execution error", async (step) => {
    failOn = step;
    const r = await runSelect({ sql: "SELECT 1" }, CFG);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(`query execution error: boom at ${step}`);
  });

  it("a guard refusal never opens a transaction", async () => {
    const r = await runSelect({ sql: "SELECT pg_sleep(1)" }, CFG);
    expect(r.isError).toBe(true);
    expect(issued).toEqual([]);
  });
});
