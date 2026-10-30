/**
 * `sample_rows` goes through the same guard as `run_select` (#363).
 *
 * It builds `SELECT * FROM "<schema>"."<table>" LIMIT n` and, until #363, sent
 * it without calling `guardQuery`. The three config-file views the deny list
 * refuses by name (#258) were therefore readable through it. Measured on
 * PostgreSQL 17.6 over a superuser connection, through the real tools:
 *
 *   run_select  SELECT * FROM pg_catalog.pg_hba_file_rules -> rejected (PG_HBA_FILE_RULES)
 *   sample_rows pg_catalog.pg_hba_file_rules               -> ok, row_count 1 (pg_hba.conf)
 *   sample_rows pg_catalog.pg_ident_file_mappings          -> ok, row_count 0
 *   sample_rows pg_catalog.pg_file_settings                -> ok, row_count 1 (postgresql.conf)
 *
 * The population is `test/fixtures/pg17-relations.txt`, every relation in
 * pg_class on a fresh 17.6 cluster (the command is in its header). Hermetic
 * like the rest of the suite: `withClient` is replaced by one that records
 * whether it was reached and answers with an empty result.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { sampleRows } = await import("../src/tools.js");
const { guardQuery } = await import("../src/sqlGuard.js");

const CFG = { connectionString: "postgres://x/y", maxRows: 10, statementTimeoutMs: 1000 };

const RELATIONS = readFileSync(new URL("./fixtures/pg17-relations.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => {
    const dot = line.indexOf(".");
    return { schema: line.slice(0, dot), table: line.slice(dot + 1) };
  });

/** The relations whose name the guard refuses, measured with this fixture on 17.6. */
const REFUSED = [
  "pg_catalog.pg_file_settings",
  "pg_catalog.pg_hba_file_rules",
  "pg_catalog.pg_ident_file_mappings",
  // Refused by the PG_REPLICATION_ORIGIN* function prefix only; their
  // definitions read nothing the guard refuses. run_select refuses them too.
  "pg_catalog.pg_replication_origin",
  "pg_catalog.pg_replication_origin_status",
];

beforeEach(() => {
  issued.length = 0;
});

describe("the guard reads the identifiers sample_rows quotes (#363)", () => {
  // sample_rows always double-quotes both names. A guard that skipped quoted
  // text, as it skips string literals, would leave the views open.
  it.each([
    ["pg_hba_file_rules", "forbidden keyword present: PG_HBA_FILE_RULES"],
    ["pg_ident_file_mappings", "forbidden keyword present: PG_IDENT_FILE_MAPPINGS"],
    ["pg_file_settings", "forbidden function family: PG_FILE_*"],
  ])("refuses SELECT * FROM \"pg_catalog\".\"%s\"", (table, reason) => {
    expect(guardQuery(`SELECT * FROM "pg_catalog"."${table}" LIMIT 10`)).toEqual({ ok: false, reason });
  });
});

describe("sample_rows refuses what run_select refuses (#363)", () => {
  it.each([
    ["pg_hba_file_rules", "forbidden keyword present: PG_HBA_FILE_RULES"],
    ["pg_ident_file_mappings", "forbidden keyword present: PG_IDENT_FILE_MAPPINGS"],
    ["pg_file_settings", "forbidden function family: PG_FILE_*"],
  ])("pg_catalog.%s is refused before a connection is made", async (table, reason) => {
    const r = await sampleRows({ schema: "pg_catalog", table, limit: 1 }, CFG);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(`query rejected by guard: ${reason}`);
    expect(issued).toEqual([]);
  });

  it("still samples an ordinary table, through the byte cap", async () => {
    const r = await sampleRows({ table: "users", limit: 3 }, CFG);
    expect(r.isError).toBeFalsy();
    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain('SELECT * FROM "public"."users" LIMIT 3');
  });

  it("still samples a catalog relation the guard does not refuse", async () => {
    const r = await sampleRows({ schema: "pg_catalog", table: "pg_settings", limit: 1 }, CFG);
    expect(r.isError).toBeFalsy();
    expect(issued).toHaveLength(1);
  });

  it("refuses a name in any case, as the guard does", async () => {
    const r = await sampleRows({ schema: "pg_catalog", table: "PG_HBA_FILE_RULES", limit: 1 }, CFG);
    expect(r.isError).toBe(true);
    expect(issued).toEqual([]);
  });
});

describe("every PostgreSQL 17 relation gets one verdict from both tools (#363)", () => {
  it("the fixture is the whole population and every name is one sample_rows accepts", () => {
    expect(RELATIONS.length).toBe(211);
    for (const { schema, table } of RELATIONS) {
      expect(`${schema}.${table}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it("sample_rows refuses exactly the relations run_select refuses by name", async () => {
    const refusedBySample: string[] = [];
    const refusedBySelect: string[] = [];
    for (const { schema, table } of RELATIONS) {
      const name = `${schema}.${table}`;
      issued.length = 0;
      const r = await sampleRows({ schema, table, limit: 1 }, CFG);
      if (r.isError) {
        expect(r.content[0]!.text).toMatch(/^query rejected by guard: /);
        expect(issued).toEqual([]);
        refusedBySample.push(name);
      } else {
        expect(issued).toHaveLength(1);
      }
      if (!guardQuery(`SELECT * FROM ${name}`).ok) refusedBySelect.push(name);
    }
    expect(refusedBySample).toEqual(refusedBySelect);
    expect(refusedBySample).toEqual(REFUSED);
  });
});
