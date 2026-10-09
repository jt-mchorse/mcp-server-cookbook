/**
 * Three more places where the guard ended a literal or a comment somewhere
 * other than where Postgres ends it (#240, same class as #236).
 *
 * 1. `$` inside an identifier. Postgres allows `$` after an identifier's first
 *    character, so `x$y$` is an alias. The dollar-quote opener matched the
 *    `$y$` inside it and blanked everything up to the next `$y$`.
 * 2. Non-ASCII dollar tags. `$é$...$é$` is a dollar string to Postgres; the
 *    ASCII-only tag class read the `'` inside it as a string opener.
 * 3. Nested block comments. Postgres nests `/* /* *\/ *\/`; the guard ended
 *    the comment at the first `*\/` and read a `'` still inside it.
 *
 * Every row of the issue's table was measured on Postgres 17: the guard said
 * ok:true, and on a superuser connection the stacked DDL ran.
 */
import { describe, expect, it } from "vitest";

import { guardQuery } from "../src/sqlGuard.js";

describe("a $ inside an identifier does not open a dollar string (#240)", () => {
  it("a forbidden call between two $-bearing aliases is seen", () => {
    const r = guardQuery("SELECT 1 AS x$y$, txid_current() AS t, pg_sleep(2) AS z$y$");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TXID_CURRENT|PG_SLEEP/);
  });

  it("a stacked statement between two $-bearing aliases is refused", () => {
    const r = guardQuery(
      "SELECT 1 AS a$q$; COMMIT; BEGIN READ WRITE; CREATE TABLE pwn2(x int); COMMIT; SELECT 1 AS b$q$",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multi-statement/);
  });

  it.each(["SELECT 1 AS x$y$, 2 AS z$y$", "SELECT price$usd FROM t", "SELECT a$$b FROM t"])(
    "legitimate $-bearing identifiers pass: %s",
    (q) => {
      expect(guardQuery(q)).toEqual({ ok: true });
    },
  );

  it.each([
    // A quote ends a token, so the next `$` opens a dollar string, as it does
    // on Postgres (`"int4"$$1$$` is a typed literal there).
    ['SELECT "int4"$$1$$, pg_sleep(1)', "PG_SLEEP"],
    ["SELECT 'a'$$;$$; DROP TABLE t", "multi-statement"],
    // Operators and punctuation end a token too.
    ["SELECT 1+$$'$$, pg_sleep(1)", "PG_SLEEP"],
    ["SELECT ($$'$$), pg_sleep(1)", "PG_SLEEP"],
  ])("a dollar string still opens after a token boundary: %s", (q, why) => {
    const r = guardQuery(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(why);
  });

  it("a dollar string after a token boundary still hides what it should", () => {
    expect(guardQuery("SELECT 'x' || $$DROP TABLE t$$")).toEqual({ ok: true });
  });
});

describe("a dollar tag may be non-ASCII (#240)", () => {
  it.each([
    "SELECT $é$'$é$ AS a, txid_current() AS x, $é$'$é$ AS b",
    "SELECT $日本$'$日本$, pg_sleep(1), $日本$'$日本$",
    "SELECT $_é1$'$_é1$, pg_sleep(1), $_é1$'$_é1$",
    // Astral code points are letters to Postgres's byte-wise lexer too.
    "SELECT $\u{1F600}$'$\u{1F600}$, pg_sleep(1), $\u{1F600}$'$\u{1F600}$",
  ])("a quote inside a non-ASCII dollar string does not hide a forbidden call: %s", (q) => {
    expect(guardQuery(q).ok).toBe(false);
  });

  it("a stacked statement between two non-ASCII dollar strings is refused", () => {
    const r = guardQuery("SELECT $é$'$é$; COMMIT; BEGIN READ WRITE; CREATE TABLE pwn(x int); COMMIT; SELECT $é$'$é$");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multi-statement/);
  });

  it("a non-ASCII dollar string hides its contents, as an ASCII one does", () => {
    expect(guardQuery("SELECT $é$DROP TABLE t; pg_sleep(1)$é$")).toEqual({
      ok: true,
    });
  });

  it("an unterminated non-ASCII dollar string fails closed", () => {
    expect(guardQuery("SELECT 1, $é$DROP TABLE users").ok).toBe(false);
  });
});

describe("block comments nest (#240)", () => {
  it("a quote inside a nested comment does not hide a forbidden call", () => {
    const r = guardQuery("SELECT 1 /* /* */ ' */, txid_current() AS x, pg_sleep(2) -- '");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TXID_CURRENT|PG_SLEEP/);
  });

  it("a stacked statement after a nested comment is refused", () => {
    const r = guardQuery("SELECT 1 /* /* */ ' */; COMMIT; BEGIN READ WRITE; DROP TABLE t; COMMIT; -- '");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multi-statement/);
  });

  it("a keyword inside a nested comment is still comment", () => {
    expect(guardQuery("SELECT 1 /* a /* DROP TABLE t */ still a comment; */ AS x")).toEqual({ ok: true });
  });

  it("depth counts every level", () => {
    expect(guardQuery("SELECT 1 /* /* /* */ */ ' */, pg_sleep(1) -- '").ok).toBe(false);
    expect(guardQuery("SELECT 1 /* /* /* */ */ */ AS x")).toEqual({ ok: true });
  });
});
