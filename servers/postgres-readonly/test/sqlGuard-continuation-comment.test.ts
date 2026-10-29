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

describe("separators Postgres does not join stay two constants (#359)", () => {
  // Postgres splits at each of these, so `'\'` is an ordinary string that
  // closes and the `')'` after it is a second literal (the query is then a
  // syntax error there, so nothing runs). Read as a continuation, `'\'` would
  // be an escaped quote and the `)` would fall outside every literal.
  // subqueryBody is the check: it lexes the raw text in one pass, while
  // guardQuery's later passes see a block comment already turned into a space.
  it.each([
    ["a block comment, then LF", ` /* c */${LF}`],
    ["LF, then a block comment", `${LF}/* c */`],
    ["LF, a block comment, LF", `${LF}/* c */${LF}`],
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
