/**
 * An `E'...'` string continued across a newline is one escape-semantics
 * constant, as in Postgres (#357).
 *
 * Postgres joins two string constants separated by whitespace that contains a
 * newline (the `quotecontinue` rule), and an `E'...'` leader carries
 * backslash-escape semantics into the continuation. The guard parsed the first
 * `E'...'` (via #236's `escapeStringEnd`) and then read the continuation
 * `'\''` as an ordinary single-quoted string, swallowing the live SQL after it.
 * Measured on PostgreSQL 17.6 (standard_conforming_strings=on, the server's
 * pinned value): `SELECT E'a'\n'\'' AS a, 'MARK' AS b` returns a=`a'`, b=`MARK`,
 * so the continuation closes and `MARK` is live SQL. A hunt agent ran the
 * stacked-DROP and pg_sleep variants end to end; I confirmed pg_sleep(2) ran on
 * origin/main (2006 ms) and is refused here before any query is sent.
 *
 * Not #236 (the first E-string parses fine), not #252 (fires with
 * standard_conforming_strings=on), not #354 (no CR comment).
 */
import { describe, expect, it } from "vitest";

import { guardQuery, subqueryBody } from "../src/sqlGuard.js";

const LF = "\n";

describe("an E'...' continuation hides no live SQL (#357)", () => {
  it.each([
    [`SELECT E'a'${LF}'\\'' AS a, pg_sleep(2)::text AS b --'`, /PG_SLEEP/],
    [`SELECT E'a'${LF}'\\''; COMMIT; BEGIN READ WRITE; DROP TABLE victim; COMMIT; SELECT 1 --'`, /multi-statement/],
    [`SELECT E'a'${LF}'\\'', txid_current() --'`, /TXID_CURRENT/],
    // The continuation separator may be any whitespace that contains a newline.
    [`SELECT E'a'\r${LF}'\\'', pg_sleep(1) --'`, /PG_SLEEP/],
    [`SELECT E'a'${LF}${LF}'\\'', pg_sleep(1) --'`, /PG_SLEEP/],
    // A second continuation hop.
    [`SELECT E'a'${LF}'b'${LF}'\\'', pg_sleep(1) --'`, /PG_SLEEP/],
    // Lowercase e opens an escape string too.
    [`SELECT e'a'${LF}'\\'', pg_sleep(1) --'`, /PG_SLEEP/],
  ])("refuses %j", (sql, reason) => {
    const r = guardQuery(sql);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("subqueryBody refuses a wrapper-closing ) reached through a continuation", () => {
    expect(subqueryBody(`SELECT E'a'${LF}'\\'' AS a) s) w`)).toBeNull();
  });
});

describe("legitimate string continuations and E-strings still pass (#357)", () => {
  it.each([
    `SELECT E'line one\\n'${LF}'line two' AS note`,
    `SELECT E'a'${LF}'b'${LF}'c' AS x`,
    `SELECT E'hello\\n' AS a`,
    `SELECT 'a'${LF}'b' AS x`,
    `SELECT 'plain' AS a`,
  ])("accepts %j", (sql) => {
    expect(guardQuery(sql)).toEqual({ ok: true });
  });

  it("an unterminated E continuation fails closed", () => {
    const r = guardQuery(`SELECT E'a'${LF}'\\'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unterminated/);
  });
});
