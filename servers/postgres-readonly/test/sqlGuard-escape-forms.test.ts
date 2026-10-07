/**
 * The guard lexes E'...' escape strings and U&"..." identifiers the way
 * Postgres does (#236).
 *
 * The three scanners knew only the `''` quote escape. Inside an `E'...'`
 * string a backslash escapes the next character, so `E'\''` is a complete
 * 3-character literal (confirmed on Postgres 17: `SELECT length(E'\'')` = 1).
 * The guard read the rest of the input as still inside the string, and a hunt
 * agent measured, on a real Postgres 17 superuser connection (the role
 * misconfiguration D-004 says the guard must cover alone):
 *
 *   SELECT E'\''; COMMIT; BEGIN READ WRITE; DROP TABLE t; COMMIT; --'
 *     -> guard ok:true, table t dropped
 *
 * And `U&"pg\005fsleep"(2)` IS `pg_sleep(2)` to Postgres (also confirmed), but
 * the keyword scan saw the escaped spelling: pg_sleep, pg_notify,
 * txid_current and pg_read_file all ran through it.
 */
import { describe, expect, it } from "vitest";

import { guardQuery } from "../src/sqlGuard.js";

describe("E'...' escape strings (#236)", () => {
  it.each([
    "SELECT E'\\''; COMMIT; BEGIN READ WRITE; DROP TABLE t; COMMIT; --'",
    "SELECT E'\\''; COMMIT; SET default_transaction_read_only = off; COMMIT; INSERT INTO t VALUES (1); --'",
    "SELECT e'\\''; DROP TABLE t; --'",
    "SELECT E'a\\\\'; DROP TABLE t; --'",
  ])("a stacked statement after an escaped quote is refused: %s", (q) => {
    const r = guardQuery(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multi-statement/);
  });

  it("a forbidden call after an E-string is still seen", () => {
    expect(guardQuery("SELECT E'\\'', pg_sleep(1)").ok).toBe(false);
  });

  it("a comment marker inside an E-string does not hide what follows", () => {
    // Read as a plain string, `E'\'` closes at `\'`, and `--` would start a
    // comment that swallows the pg_sleep. It is all one literal to Postgres.
    const r = guardQuery("SELECT E'\\'--', pg_sleep(1)");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("PG_SLEEP");
  });

  it("an unterminated E-string fails closed", () => {
    expect(guardQuery("SELECT E'abc\\'").ok).toBe(false);
  });

  it.each(["SELECT E'a\\nb'", "SELECT e'it\\'s', E'x''y'", "SELECT E'\\\\' AS backslash"])(
    "legitimate escape strings pass: %s",
    (q) => {
      expect(guardQuery(q)).toEqual({ ok: true });
    },
  );

  it("a letter E that ends an identifier does not open an escape string", () => {
    // `somee` then the plain string 'x'.
    expect(guardQuery("SELECT somee'x'")).toEqual({ ok: true });
  });
});

describe('U&"..." identifiers (#236)', () => {
  it.each([
    ['SELECT U&"pg\\005fsleep"(2)', "PG_SLEEP"],
    ['SELECT U&"txid\\005fcurrent"()', "TXID_CURRENT"],
    ["SELECT U&\"pg\\005fnotify\"('ch','x')", "PG_NOTIFY"],
    ["SELECT U&\"pg\\005fread\\005ffile\"('postmaster.pid')", "PG_READ_FILE"],
    ['SELECT u&"pg\\+00005fsleep"(1)', "PG_SLEEP"],
  ])("the decoded name is scanned: %s", (q, kw) => {
    const r = guardQuery(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(kw);
  });

  it("a custom UESCAPE character is refused rather than modelled", () => {
    const r = guardQuery("SELECT U&\"pg!005fsleep\" UESCAPE '!'");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/UESCAPE/);
  });

  it("an escape Postgres would reject fails closed", () => {
    expect(guardQuery('SELECT U&"a\\zz" FROM t').ok).toBe(false);
  });

  it("a benign U& identifier passes", () => {
    expect(guardQuery('SELECT U&"d\\0061ta" FROM t')).toEqual({ ok: true });
  });
});
