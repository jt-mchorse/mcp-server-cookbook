/**
 * `run_select` and `sample_rows` bound a result's BYTES in Postgres (#347).
 *
 * MAX_ROWS (#256) bounded rows only. Measured on PostgreSQL 17.6 through the
 * built server: `SELECT repeat('x', 600000000)` was never answered and the
 * process exited 1 with ERR_STRING_TOO_LONG, thrown inside pg-protocol's socket
 * handler where no catch reaches; `repeat('x', 4e8)` returned after a 1960 MB
 * peak. The query now runs as the inner subquery of a wrapper whose running
 * byte total fails the FETCH at the first row past MAX_RESULT_BYTES, so the
 * row never leaves the database.
 *
 * Hermetic like the rest of the suite: `withClient` hands the tools a client
 * that records the SQL it is sent, and answers the way Postgres does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const issued: string[] = [];
/** When set, the data query fails with Postgres's cast error for this running total. */
let overCapTotal: number | undefined;
let failWith: string | undefined;

/** The nonce and column the wrapper in `text` uses, read the way a reader of the SQL would. */
function wrapperOf(text: string): { nonce: string; column: string } | undefined {
  const m = text.match(/AS (mcp_bytes_([0-9a-f]+)) FROM \(/);
  return m ? { column: m[1]!, nonce: m[2]! } : undefined;
}

let declared: string | undefined;

vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  withClient: async (_cfg: unknown, fn: (c: unknown) => unknown) =>
    fn({
      query: async (q: string | { text: string }) => {
        const text = typeof q === "string" ? q : q.text;
        issued.push(text);
        if (text.startsWith("DECLARE")) declared = text;
        const wrapped = text.startsWith("FETCH") ? declared : text.startsWith("SELECT * FROM (") ? text : undefined;
        const isData = /^(FETCH|SELECT|EXPLAIN)\b/.test(text);
        if (isData && failWith !== undefined) throw new Error(failWith);
        const w = wrapped === undefined ? undefined : wrapperOf(wrapped);
        if (!w) return { fields: [], rows: [] };
        if (overCapTotal !== undefined) {
          throw new Error(`invalid input syntax for type integer: "${w.nonce}:${overCapTotal}"`);
        }
        return {
          fields: [
            { name: "g", dataTypeID: 23 },
            { name: "note", dataTypeID: 25 },
            { name: w.column, dataTypeID: 20 },
          ],
          rows: [
            [1, "a", "3"],
            [2, "b", "6"],
          ],
        };
      },
    }),
}));

const { runSelect, sampleRows, byteCappedQuery, withoutByteColumn, byteCapError } = await import("../src/tools.js");
const { subqueryBody } = await import("../src/sqlGuard.js");
const { DEFAULT_MAX_RESULT_BYTES, MAX_MAX_RESULT_BYTES, readDbConfigFromEnv, validateDbConfig } = await import(
  "../src/db.js"
);

const CFG = { connectionString: "postgres://x/y", maxRows: 10, statementTimeoutMs: 1000 };

beforeEach(() => {
  issued.length = 0;
  overCapTotal = undefined;
  failWith = undefined;
  declared = undefined;
});

describe("the byte-capped wrapper (#347)", () => {
  it("measures the WHOLE ROW as (s.*), never a bare s a column of that name would shadow", () => {
    // Measured on Postgres 17.6: with a column named `s`, `octet_length(s::text)`
    // was 4 (the column) for a row whose `(s.*)::text` was 57.
    const { sql } = byteCappedQuery("SELECT 1", 100, "abc");
    expect(sql).toContain("octet_length((s.*)::text)");
    expect(sql).not.toMatch(/[^.(]s::text/);
  });

  it("puts the body on its own lines, so a trailing -- comment cannot swallow the closing parenthesis", () => {
    expect(byteCappedQuery("SELECT 1 -- note", 100, "abc").sql).toContain("FROM (\nSELECT 1 -- note\n) s) w ");
  });

  it("raises past the cap with a cast that carries the nonce, and names its column with it", () => {
    const cap = byteCappedQuery("SELECT 1", 4096, "f00d");
    expect(cap.column).toBe("mcp_bytes_f00d");
    expect(cap.sql).toContain("AS mcp_bytes_f00d FROM (");
    expect(cap.sql).toContain("WHEN w.mcp_bytes_f00d > 4096 THEN ('f00d:' || w.mcp_bytes_f00d)::int = 0");
  });

  it("uses a fresh nonce per call", () => {
    expect(byteCappedQuery("SELECT 1", 1).nonce).not.toBe(byteCappedQuery("SELECT 1", 1).nonce);
  });

  it("strips its own trailing column from fields and rows", () => {
    const cap = byteCappedQuery("SELECT 1", 1, "ab");
    const out = withoutByteColumn(
      { fields: [{ name: "a" }, { name: "mcp_bytes_ab" }], rows: [[1, "9"]] },
      cap,
    );
    expect(out).toEqual({ fields: [{ name: "a" }], rows: [[1]] });
  });

  it("leaves a result alone whose last column is not its own (control)", () => {
    const cap = byteCappedQuery("SELECT 1", 1, "ab");
    const r = { fields: [{ name: "a" }, { name: "mcp_bytes_cd" }], rows: [[1, 2]] };
    expect(withoutByteColumn(r, cap)).toBe(r);
  });

  it("reports only an error carrying its own nonce as over the cap", () => {
    const cap = byteCappedQuery("SELECT 1", 1, "ab");
    expect(byteCapError('invalid input syntax for type integer: "ab:77"', cap, "MAX_RESULT_BYTES")).toMatch(
      /77 bytes as text, over the MAX_RESULT_BYTES cap of 1 bytes/,
    );
    expect(byteCapError('invalid input syntax for type integer: "cd:77"', cap, "MAX_RESULT_BYTES")).toBeUndefined();
  });
});

describe("subqueryBody: the query as text that can sit inside parentheses (#347)", () => {
  it.each([
    ["SELECT 1", "SELECT 1"],
    ["SELECT 1;", "SELECT 1"],
    ["SELECT 1; -- bye", "SELECT 1"],
    ["SELECT 1;;", "SELECT 1"],
    ["SELECT 1 -- trailing", "SELECT 1 -- trailing"],
    ["SELECT ';' AS a", "SELECT ';' AS a"],
    ["SELECT ')' AS p, \"a)\" FROM (SELECT 1 AS \"a)\") z", "SELECT ')' AS p, \"a)\" FROM (SELECT 1 AS \"a)\") z"],
    ["SELECT $$)$$, $t$($t$", "SELECT $$)$$, $t$($t$"],
    ["SELECT E'\\')' AS e", "SELECT E'\\')' AS e"],
    ["SELECT 'it''s )' AS e", "SELECT 'it''s )' AS e"],
    ["SELECT 1 /* ) /* ( */ ) */", "SELECT 1 /* ) /* ( */ ) */"],
    ["SELECT 1 -- )\n, 2", "SELECT 1 -- )\n, 2"],
  ])("%j -> %j", (sql, body) => {
    expect(subqueryBody(sql)).toBe(body);
  });

  it.each([
    // Closes the wrapper early and comments out the size check.
    "SELECT repeat('x', 600000000)) s) w /*",
    "SELECT 1)",
    "SELECT (1",
    "SELECT 1 /* open",
    "SELECT 1 /* /* */",
    "SELECT 'open",
  ])("refuses %j", (sql) => {
    expect(subqueryBody(sql)).toBeNull();
  });
});

describe("run_select reads through the wrapper (#347)", () => {
  it("returns the rows without the wrapper's column", async () => {
    const r = await runSelect({ sql: "SELECT g, note FROM t" }, CFG);
    expect(r.isError).toBeFalsy();
    const p = JSON.parse(r.content[0]!.text);
    expect(p.fields).toEqual([
      { name: "g", dataTypeID: 23 },
      { name: "note", dataTypeID: 25 },
    ]);
    expect(p.rows).toEqual([
      { g: 1, note: "a" },
      { g: 2, note: "b" },
    ]);
  });

  it("an over-cap result is an isError naming MAX_RESULT_BYTES and the cap, not a crash", async () => {
    overCapTotal = 600000002;
    const r = await runSelect({ sql: "SELECT repeat('x', 600000000) AS w" }, CFG);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(
      `result too large: the rows read so far total 600000002 bytes as text, over the MAX_RESULT_BYTES cap of ` +
        `${DEFAULT_MAX_RESULT_BYTES} bytes (#347); select fewer rows or columns, or shorten large values (e.g. left(col, 1000))`,
    );
  });

  it("the default cap is in the cursor body; cfg.maxResultBytes replaces it", async () => {
    await runSelect({ sql: "SELECT 1" }, CFG);
    expect(declared).toContain(` > ${DEFAULT_MAX_RESULT_BYTES} THEN `);
    await runSelect({ sql: "SELECT 1" }, { ...CFG, maxResultBytes: 4096 });
    expect(declared).toContain(" > 4096 THEN ");
  });

  it("a trailing ; still runs, cut from the body", async () => {
    const r = await runSelect({ sql: "SELECT 1;" }, CFG);
    expect(r.isError).toBeFalsy();
    expect(declared).toContain("FROM (\nSELECT 1\n) s) w ");
  });

  it("a query that would close the wrapper early is refused before connecting", async () => {
    const r = await runSelect({ sql: "SELECT repeat('x', 600000000)) s) w /*" }, CFG);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/unbalanced parentheses/);
    expect(issued).toEqual([]);
  });

  it("any other database error keeps its message (control)", async () => {
    failWith = 'relation "nope" does not exist';
    const r = await runSelect({ sql: "SELECT * FROM nope" }, CFG);
    expect(r.content[0]!.text).toBe('query execution error: relation "nope" does not exist');
  });

  it("EXPLAIN is still read directly, not wrapped (control)", async () => {
    await runSelect({ sql: "EXPLAIN SELECT 1" }, CFG);
    expect(issued).toEqual(["EXPLAIN SELECT 1"]);
  });
});

describe("sample_rows gets the same bound (#347)", () => {
  it("wraps its own SELECT and strips the wrapper's column", async () => {
    const r = await sampleRows({ table: "t", limit: 5 }, CFG);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain('FROM (\nSELECT * FROM "public"."t" LIMIT 5\n) s) w ');
    expect(JSON.parse(r.content[0]!.text).rows).toEqual([
      { g: 1, note: "a" },
      { g: 2, note: "b" },
    ]);
  });

  it("an over-cap sample is an isError naming the cap", async () => {
    overCapTotal = 17000076;
    const r = await sampleRows({ table: "wide", limit: 50 }, { ...CFG, maxResultBytes: 16777216 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/17000076 bytes as text, over the MAX_RESULT_BYTES cap of 16777216 bytes/);
  });
});

describe("MAX_RESULT_BYTES configuration (#347)", () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
    Object.assign(process.env, SAVED);
  });
  function fromEnv(raw: string | undefined) {
    process.env.DATABASE_URL = "postgres://ro@localhost/db";
    delete process.env.MAX_ROWS;
    delete process.env.STATEMENT_TIMEOUT_MS;
    if (raw === undefined) delete process.env.MAX_RESULT_BYTES;
    else process.env.MAX_RESULT_BYTES = raw;
    return readDbConfigFromEnv();
  }

  it("defaults to 16 MiB, under the 4e8-character value measured at a 1960 MB peak", () => {
    expect(DEFAULT_MAX_RESULT_BYTES).toBe(16 * 1024 * 1024);
    expect(fromEnv(undefined).maxResultBytes).toBe(DEFAULT_MAX_RESULT_BYTES);
  });

  it("reads a plain integer, trimmed", () => {
    expect(fromEnv(" 4096 ").maxResultBytes).toBe(4096);
  });

  it("is bounded by V8's maximum string length", () => {
    expect(MAX_MAX_RESULT_BYTES).toBe(0x1fffffe8);
    expect(fromEnv(String(MAX_MAX_RESULT_BYTES)).maxResultBytes).toBe(MAX_MAX_RESULT_BYTES);
    expect(() => fromEnv(String(MAX_MAX_RESULT_BYTES + 1))).toThrow(/MAX_RESULT_BYTES must be <= 536870888/);
  });

  it.each(["16MB", "1e7", "0", "-1", "abc"])("refuses %j", (raw) => {
    expect(() => fromEnv(raw)).toThrow(/MAX_RESULT_BYTES/);
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_MAX_RESULT_BYTES + 1])("validateDbConfig refuses maxResultBytes %s", (n) => {
    expect(() => validateDbConfig({ ...CFG, maxResultBytes: n })).toThrow(/maxResultBytes/);
  });

  it("validateDbConfig accepts a config without maxResultBytes (control)", () => {
    expect(() => validateDbConfig(CFG)).not.toThrow();
  });
});
