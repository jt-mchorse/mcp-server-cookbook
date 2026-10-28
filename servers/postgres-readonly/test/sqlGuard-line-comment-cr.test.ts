/**
 * A `--` comment ends at a CR as well as an LF (#354).
 *
 * Postgres's lexer defines `newline [\n\r]` and `comment ("--"{non_newline}*)`
 * (scan.l), so a bare carriage return ends a line comment. The guard's two
 * `--` skips (`stripComments` and `subqueryBody`) stopped at LF only:
 * everything after `--<CR>` was a comment to the guard and live SQL to
 * Postgres. `run_select` sends unparameterised text over the simple-query
 * protocol, which runs every statement in it. Measured on PostgreSQL 18.0
 * through `runSelect`: a stacked `DROP TABLE` ran, `pg_sleep(3)` slept, and
 * `--<CR>) s) w` closed #349's size-cap wrapper early.
 *
 * CR is built from its code point so no editor or tool can normalise it.
 */
import { describe, expect, it } from "vitest";

import { guardQuery, leadingKeyword, subqueryBody } from "../src/sqlGuard.js";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

describe("a CR ends a -- comment in the guard, as in Postgres (#354)", () => {
  it.each([
    [`EXPLAIN SELECT 1 --${CR}; COMMIT; BEGIN READ WRITE; DROP TABLE victim; COMMIT`, "multi-statement"],
    [`SELECT 1 --${CR}, pg_sleep(3)`, "PG_SLEEP"],
    [`SELECT 1 --${CR}; DROP TABLE victim`, "multi-statement"],
    [`SELECT 1 AS a --x${CR}, txid_current() AS b`, "TXID_CURRENT"],
    [`SELECT 1 --${CR}INTO pwned`, "INTO"],
    // CRLF, and a CR right after the dashes with nothing between.
    [`SELECT 1 --x${CR}${LF}, pg_sleep(1)`, "PG_SLEEP"],
    [`SELECT 1 --${CR}${CR}, pg_sleep(1)`, "PG_SLEEP"],
    // The comment comes first; what follows its CR is the statement.
    [`--${CR}DELETE FROM t`, "DELETE"],
  ])("what follows --<CR> is scanned: %j", (q, why) => {
    const r = guardQuery(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(why);
  });

  it("the leading keyword is read after a --<CR> comment", () => {
    expect(leadingKeyword(`--x${CR}SELECT 1`)).toBe("SELECT");
    expect(guardQuery(`--x${CR}SELECT 1`)).toEqual({ ok: true });
  });

  it("subqueryBody refuses a wrapper-closing ) after --<CR>", () => {
    expect(subqueryBody(`SELECT 1 AS a --${CR}) s) w`)).toBeNull();
    expect(subqueryBody(`SELECT 1 AS a --x${CR}${LF}) s) w; CREATE TABLE pwned(x int)`)).toBeNull();
  });

  it("subqueryBody cuts at a ; that follows --<CR>", () => {
    expect(subqueryBody(`SELECT 1 --c${CR}; `)).toBe(`SELECT 1 --c${CR}`);
  });
});

describe("controls: a CR changes nothing where it is not ending a comment", () => {
  it.each([
    `SELECT 1${CR}`,
    `SELECT${CR}1`,
    `SELECT 1 -- a comment${CR}${LF}`,
    `SELECT 1 -- DROP TABLE t${CR}`,
    `SELECT 1 -- trailing comment, no newline at all`,
    `SELECT 1 /* block ${CR} comment */`,
  ])("benign SQL with a CR passes: %j", (q) => {
    expect(guardQuery(q)).toEqual({ ok: true });
  });

  it.each([
    // A CR inside a literal or identifier does not end a comment that never began.
    `SELECT '--${CR}; DROP TABLE t'`,
    `SELECT E'--${CR}; DROP TABLE t'`,
    `SELECT $$--${CR}; DROP TABLE t$$`,
    // Identifiers are keyword-scanned on purpose, so this one holds no keyword.
    `SELECT 1 AS "--${CR}; x"`,
  ])("-- and a CR inside a literal or identifier stay inert: %j", (q) => {
    expect(guardQuery(q)).toEqual({ ok: true });
  });

  it("subqueryBody keeps a CR-terminated comment and balanced parentheses", () => {
    expect(subqueryBody(`SELECT (1) -- c${CR}+ (2)`)).toBe(`SELECT (1) -- c${CR}+ (2)`);
    expect(subqueryBody(`SELECT '(' -- )${CR}`)).toBe(`SELECT '(' -- )${CR}`);
  });

  it("an LF-terminated comment behaves as before", () => {
    expect(guardQuery(`SELECT 1 --${LF}, pg_sleep(3)`).reason).toContain("PG_SLEEP");
    expect(subqueryBody(`SELECT 1 AS a --${LF}) s) w`)).toBeNull();
  });
});
