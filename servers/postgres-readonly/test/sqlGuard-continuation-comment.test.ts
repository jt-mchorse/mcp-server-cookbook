/**
 * A `--` comment in the separator of an `E'...'` continuation is whitespace,
 * as in Postgres (#359).
 *
 * #357 joined `E'a'<newline>'...'` into one escape-semantics constant, but only
 * when the separator was raw whitespace. Postgres's `quotecontinue` is
 * `{whitespace_with_newline}{quote}`, and its whitespace includes `--` line
 * comments (scan.l), so `E'a' -- c<LF>'\''` is ONE constant there. The guard
 * closed the string at the first `'`, read `'\''` as an ordinary string and
 * fell out of step with the server. Measured on PostgreSQL 17.6
 * (standard_conforming_strings=on): `SELECT E'a' -- c<LF>'\'' AS a, ' -- ',
 * pg_sleep(2) AS z, '<LF>' AS w` was `{ok:true}` and slept 2004 ms, a = `a'`.
 *
 * Every separator below was run against that Postgres as
 * `SELECT E'a'<sep>'b' AS x`: the JOIN rows returned `ab`, the SPLIT rows did
 * not (a syntax error, or a comment that ran to the end of the input). A block
 * comment is NOT continuation whitespace. Control characters are built from
 * their code points so no editor can normalise them.
 */
import { describe, expect, it } from "vitest";

import { guardQuery, subqueryBody } from "../src/sqlGuard.js";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const VT = String.fromCharCode(11);

// Separators Postgres treats as a continuation (measured: `ab`).
const JOIN: [string, string][] = [
  ["space, comment, LF", ` -- c${LF}`],
  ["comment right after the quote", `--c${LF}`],
  ["tabs around the comment", `${TAB}-- c${TAB}${LF}`],
  ["comment, LF, then a tab", ` -- c${LF}${TAB}`],
  ["two comments", ` -- c${LF} -- d${LF}`],
  ["LF, then a comment line", `${LF}-- c${LF}`],
  ["comment ended by a bare CR", ` -- c${CR}`],
  ["comment ended by CRLF", ` -- c${CR}${LF}`],
  ["comment holding a quote", ` -- it's${LF}`],
  ["comment holding a backslash-quote", ` -- \\'${LF}`],
  ["comment holding /*", ` -- /* ${LF}`],
  ["empty comment", ` --${LF}`],
  ["VT before the comment", `${VT}-- c${LF}`],
];

describe("a -- comment in an E-string continuation separator is whitespace (#359)", () => {
  it("the issue's payload is refused", () => {
    const r = guardQuery(`SELECT E'a' -- c${LF}'\\'' AS a, ' -- ', pg_sleep(2) AS z, '${LF}' AS w`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/PG_SLEEP/);
  });

  it.each(JOIN)("joins across %s, so the pg_sleep after it is seen", (_name, sep) => {
    const r = guardQuery(`SELECT E'a'${sep}'\\'' AS a, ' -- ', pg_sleep(0) AS z, '${LF}' AS w`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/PG_SLEEP/);
  });

  it.each(JOIN)("accepts a legitimate continuation across %s", (_name, sep) => {
    // Postgres: a = `a'`, b = `)`. Read as two constants, the `)` is outside
    // any literal and unbalances the parentheses.
    const sql = `SELECT E'a'${sep}'\\'' AS a, ')' AS b`;
    expect(guardQuery(sql)).toEqual({ ok: true });
    expect(subqueryBody(sql)).toBe(sql);
  });

  it("a stacked statement after a commented continuation is still one too many", () => {
    const r = guardQuery(`SELECT E'a' -- c${LF}'\\''; DROP TABLE victim; SELECT 1 --'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/multi-statement/);
  });
});

// Separators holding a block comment, which Postgres does not join. Measured on
// PostgreSQL 17.6: `SELECT E'a'<sep>'b'` is `syntax error at or near "'b'"` for
// every row.
const SPLIT_BLOCK: [string, string][] = [
  ["a block comment, then LF", ` /* c */${LF}`],
  ["LF, then a block comment", `${LF}/* c */`],
  ["LF, a block comment, LF", `${LF}/* c */${LF}`],
  ["a block comment holding the LF", ` /* c${LF} */`],
  ["a nested block comment, then LF", ` /* a /* b */ c */${LF}`],
  ["a -- comment, a block comment, LF", ` -- c${LF}/* d */${LF}`],
  ["a block comment, then a -- comment", ` /* c */ -- d${LF}`],
  ["a block comment, then a bare CR", ` /* c */${CR}`],
  ["LF, a block comment, a tab", `${LF}/* c */${TAB}`],
  ["VT, a block comment, LF", `${VT}/* c */${LF}`],
  ["an empty block comment, then LF", `/**/${LF}`],
];

describe("separators Postgres does not join stay two constants (#359)", () => {
  // Postgres splits at each of these, so `'\'` is an ordinary string that
  // closes and the `')'` after it is a second literal (the query is then a
  // syntax error there, so nothing runs). Read as a continuation, `'\'` would
  // be an escaped quote and the `)` would fall outside every literal.
  // subqueryBody lexes the raw text in one pass; guardQuery's side of the
  // block-comment rows is pinned by the #361 block below.
  it.each([
    ...SPLIT_BLOCK,
    ["spaces with no newline", "  "],
    ["a lone dash and LF", ` -${LF}`],
  ])("does not join across %s", (_name, sep) => {
    const sql = `SELECT E'a'${sep}'\\' AS a, ')' AS b`;
    expect(subqueryBody(sql)).toBe(sql);
  });

  it.each([
    ["spaces with no newline", "  "],
    ["a lone dash and LF", ` -${LF}`],
  ])("guardQuery sees the pg_sleep after a split across %s", (_name, sep) => {
    const r = guardQuery(`SELECT E'a'${sep}'\\' AS a, pg_sleep(0) AS z --'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/PG_SLEEP/);
  });

  it("a -- comment that runs to the end of the input continues nothing", () => {
    expect(guardQuery(`SELECT E'a' -- c'b'`)).toEqual({ ok: true });
  });
});

/**
 * guardQuery reads the text twice, and the two reads must agree about a block
 * comment (#361). `stripComments` turned a block comment into a space, and the
 * later passes then joined the next `'...'` onto the `E'...'` string as a
 * continuation, which Postgres does not do. `E'a'`, a block comment, LF and
 * `'\' AS a, pg_sleep(0) AS z'` was `{ ok: true }` with the `pg_sleep` unseen;
 * Postgres 17.6 rejects it (`syntax error at or near "'\'"`). The guard now
 * refuses that shape. Every query of it holds two adjacent string constants, a
 * syntax error on the server, so no valid query is lost.
 */
describe("a block comment cannot make guardQuery join what Postgres splits (#361)", () => {
  const REASON = /block comment between an E'\.\.\.' string/;

  it("the issue's shape is refused", () => {
    const r = guardQuery(`SELECT E'a' /* c */${LF}'\\' AS a, pg_sleep(0) AS z'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(REASON);
  });

  it("the issue's payload as written is refused", () => {
    expect(guardQuery(`SELECT E'a' /* c */${LF}'\\' AS a, pg_sleep(0) AS z --'`).ok).toBe(false);
  });

  it.each(SPLIT_BLOCK)("never misses the pg_sleep after a split across %s", (_name, sep) => {
    for (const tail of ["'", " --'", ", ' ' AS w'"]) {
      const sql = `SELECT E'a'${sep}'\\' AS a, pg_sleep(0) AS z${tail}`;
      expect(guardQuery(sql).ok, JSON.stringify(sql)).toBe(false);
    }
  });

  it.each(SPLIT_BLOCK.filter(([name]) => name !== "a block comment holding the LF"))(
    "refuses the two constants Postgres measured, split by %s",
    (_name, sep) => {
      const r = guardQuery(`SELECT E'a'${sep}'b' AS x`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(REASON);
    },
  );

  it("a block comment that holds the only newline leaves nothing to join", () => {
    // Stripped, it is one space and no newline, so neither read joins.
    expect(guardQuery(`SELECT E'a' /* c${LF} */'b' AS x`)).toEqual({ ok: true });
  });

  it("a continuation chain followed by a block comment is refused", () => {
    // Postgres 17.6: `E'a'<LF>'b'` is one constant, and the block comment ends it.
    const r = guardQuery(`SELECT E'a'${LF}'b' /* c */${LF}'\\'' AS x`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(REASON);
  });

  it.each(JOIN)("a real continuation across %s is still accepted", (_name, sep) => {
    const sql = `SELECT E'a'${sep}'\\'' /* c */ AS a, ')' AS b`;
    expect(guardQuery(sql)).toEqual({ ok: true });
    expect(subqueryBody(sql)).toBe(sql);
  });

  it.each([
    // Postgres 17.6 runs each of these.
    ["a comma after the block comment", `SELECT E'a' /* c */${LF}, 'b' AS y`],
    ["an E-string after the block comment", `SELECT E'a' /* c */${LF}|| E'b' AS y`],
    ["a plain string before the block comment", `SELECT 'a' /* c */${LF}|| 'b' AS y`],
    ["a block comment before the E-string", `SELECT /* c */${LF}E'a' AS y`],
  ])("accepts %s", (_name, sql) => {
    expect(guardQuery(sql)).toEqual({ ok: true });
  });

  // Payloads refused before this change, from earlier lexing fixes. The new
  // check only adds a refusal, so each must stay refused.
  it.each([
    ["#236 escaped quote", "SELECT E'\\'', pg_sleep(1)"],
    ["#240 alias dollar", "SELECT 1 AS x$y$, txid_current() AS t, pg_sleep(2) AS z$y$"],
    ["#240 nested comment", "SELECT 1 /* /* */ ' */, txid_current() AS x, pg_sleep(2) -- '"],
    ["#240 nested comment, stacked DDL", "SELECT 1 /* /* */ ' */; COMMIT; BEGIN READ WRITE; DROP TABLE t; COMMIT; -- '"],
    ["#354 CR ends a -- comment", `SELECT 1 --${CR}, pg_sleep(3)`],
    ["#357 continuation across LF", `SELECT E'a'${LF}'\\'' AS a, ' ', pg_sleep(2) AS z, '' AS w`],
    ["#359 continuation across a -- comment", `SELECT E'a' -- c${LF}'\\'' AS a, ' -- ', pg_sleep(2) AS z, '${LF}' AS w`],
    ["#359 stacked statement", `SELECT E'a' -- c${LF}'\\''; DROP TABLE victim; SELECT 1 --'`],
    ["a block comment, then stacked DDL", `SELECT E'a' /* c */${LF}'\\'; DROP TABLE victim; SELECT 1 --'`],
    ["a block comment, then an unclosed pg_sleep", `SELECT E'a' /* c */${LF}'\\' AS a, pg_sleep(0) AS z`],
  ])("%s stays refused", (_name, sql) => {
    expect(guardQuery(sql).ok).toBe(false);
  });
});
