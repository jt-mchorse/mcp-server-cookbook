/**
 * Functions that execute a string argument as SQL are refused (#254).
 *
 * The keyword scan runs after string contents are blanked, so a forbidden call
 * written inside the SQL string of one of these functions was invisible.
 * Measured on Postgres 17.6 through `runSelect` on `main`:
 *
 *   SELECT query_to_xml('SELECT pg_terminate_backend(<pid>)', true, true, '')
 *     -> guard ok; the other session got "terminating connection due to
 *        administrator command"
 *   SELECT * FROM ts_stat('SELECT to_tsvector(pg_sleep(1)::text)')
 *     -> guard ok; ran in 1012 ms
 */
import { describe, expect, it } from "vitest";

import { guardQuery } from "../src/sqlGuard.js";

describe("SQL-string executors (#254)", () => {
  it.each([
    ["SELECT query_to_xml('SELECT pg_terminate_backend(123)', true, true, '')", "QUERY_TO_XML"],
    ["SELECT query_to_xml('SELECT txid_current()', true, true, '')", "QUERY_TO_XML"],
    ["SELECT query_to_xmlschema('SELECT pg_sleep(1)', true, true, '')", "QUERY_TO_XML"],
    ["SELECT query_to_xml_and_xmlschema('SELECT pg_sleep(1)', true, true, '')", "QUERY_TO_XML"],
    ["SELECT pg_catalog.query_to_xml($$SELECT pg_read_file('PG_VERSION')$$, true, true, '')", "QUERY_TO_XML"],
    ["SELECT \"query_to_xml\"('SELECT 1', true, true, '')", "QUERY_TO_XML"],
    ["SELECT * FROM ts_stat('SELECT to_tsvector(pg_sleep(1)::text)')", "TS_STAT"],
    ["SELECT * FROM ts_stat('SELECT to_tsvector(pg_sleep(1)::text)', 'ab')", "TS_STAT"],
    [
      "SELECT ts_rewrite('a'::tsquery, 'SELECT ''a''::tsquery, ''b''::tsquery FROM (SELECT pg_sleep(1)) s')",
      "TS_REWRITE",
    ],
    ["SELECT * FROM crosstab('SELECT pg_sleep(1)::text, 1, 1') AS t(a text, b int)", "CROSSTAB"],
    ["SELECT * FROM crosstab3('SELECT 1')", "CROSSTAB"],
    ["SELECT * FROM connectby('t', 'id', 'parent', '1', 0) AS t(id int, p int, l int)", "CONNECTBY"],
  ])("refused: %s", (q, family) => {
    const r = guardQuery(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(`forbidden function family: ${family}*`);
  });

  it("a U&-escaped spelling is decoded, then refused", () => {
    const r = guardQuery("SELECT U&\"query\\005fto\\005fxml\"('SELECT 1', true, true, '')");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("forbidden function family: QUERY_TO_XML*");
  });

  it.each([
    // These take a table, schema or nothing, never SQL text.
    "SELECT table_to_xml('t'::regclass, true, true, '')",
    "SELECT schema_to_xml('public', true, true, '')",
    "SELECT table_to_xmlschema('t'::regclass, true, true, '')",
    // A column or alias that merely contains the name is not a call.
    "SELECT my_query_to_xml_cache FROM t",
    "SELECT 'query_to_xml' AS name",
  ])("still allowed: %s", (q) => {
    expect(guardQuery(q)).toEqual({ ok: true });
  });
});
