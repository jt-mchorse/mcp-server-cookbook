/**
 * xml2's `xpath_table` executes SQL built from its string arguments (#330).
 *
 * A #254 sibling: the keyword scan runs after string contents are blanked, so a
 * forbidden call written inside xpath_table's relation (or key, field or
 * condition) string was invisible. Measured on Postgres 17.6 through
 * `runSelect` on `main` f28344b:
 *
 *   SELECT * FROM xpath_table('k','d','(SELECT 1 AS k, ''<a>1</a>''::text AS d,
 *     pg_terminate_backend(<pid>)) s','/a','true') AS t(k int, a text)
 *     -> guard ok; the other session got "terminating connection due to
 *        administrator command"
 *   ... the same with dblink_exec(<conn>, 'DELETE FROM victim') in that slot
 *     -> guard ok; victim rows 3 -> 0
 */
import { describe, expect, it } from "vitest";

import { guardQuery } from "../src/sqlGuard.js";

describe("xpath_table executes a SQL string (#330)", () => {
  it.each([
    // The two repros from the issue.
    "SELECT * FROM xpath_table('k','d','(SELECT 1 AS k, ''<a>1</a>''::text AS d, pg_terminate_backend(29088)) s','/a','true') AS t(k int, a text)",
    "SELECT * FROM xpath_table('k','d','(SELECT 1 AS k, ''<a>1</a>''::text AS d, dblink_exec(''host=h dbname=postgres'', ''DELETE FROM victim'')) s','/a','true') AS t(k int, a text)",
    // The condition slot is pasted in too.
    "SELECT * FROM xpath_table('id','doc','docs','/a','pg_sleep(1) IS NOT NULL') AS t(id int, a text)",
    // Spellings: qualified, upper case, double-quoted, dollar-quoted argument.
    "SELECT * FROM public.xpath_table('k','d','t','/a','true') AS t(k int, a text)",
    "SELECT * FROM XPATH_TABLE('k','d','t','/a','true') AS t(k int, a text)",
    "SELECT * FROM \"xpath_table\"('k','d','t','/a','true') AS t(k int, a text)",
    "SELECT * FROM public.\"xpath_table\"('k','d',$$(SELECT 1 AS k, '<a/>'::text AS d) s$$,'/a','true') AS t(k int, a text)",
  ])("refused: %s", (q) => {
    const r = guardQuery(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("forbidden function family: XPATH_TABLE*");
  });

  it("a U&-escaped spelling is decoded, then refused", () => {
    const r = guardQuery("SELECT * FROM U&\"xpath\\005ftable\"('k','d','t','/a','true') AS t(k int, a text)");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("forbidden function family: XPATH_TABLE*");
  });

  it.each([
    // xml2's other functions evaluate an XPath over a document argument; core
    // xpath/xmltable likewise. None of them runs SQL.
    "SELECT xpath_string('<a>1</a>', '/a')",
    "SELECT xpath_number('<a>1</a>', '/a')",
    "SELECT xpath_bool('<a>1</a>', '/a')",
    "SELECT xpath_nodeset('<a>1</a>', '/a', 'r', 'i')",
    "SELECT xpath_list('<a>1</a>', '/a', ',')",
    "SELECT xpath('/a', '<a>1</a>'::xml)",
    "SELECT xpath_exists('/a', '<a>1</a>'::xml)",
    "SELECT * FROM xmltable('/a' PASSING CAST('<a>1</a>' AS xml) COLUMNS v text PATH '.')",
    // A column or literal that merely contains the name is not a call.
    "SELECT my_xpath_table_cache FROM t",
    "SELECT 'xpath_table' AS name",
  ])("still allowed: %s", (q) => {
    expect(guardQuery(q)).toEqual({ ok: true });
  });
});
