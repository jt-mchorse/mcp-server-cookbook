/**
 * Diagnostic response headers parse the same integer grammar the env vars do,
 * and map anything else to `null` (#154).
 *
 * `_parseIntHeader` used `Number.parseInt(raw, 10)`, which stops at the first
 * character it cannot consume and returns what it has. #152 unified the
 * numeric *environment-variable* grammar across all three servers that parse
 * one and deliberately left this site alone, because the contract genuinely
 * differs: an env var is operator config and a malformed one should refuse the
 * boot, while a response header is remote input on an error path and must not
 * fail a request that otherwise worked.
 *
 * So this shares #152's **grammar** and keeps its own **contract**: `null`,
 * never a throw. The disagreement between the two sites is about what an
 * unreadable value *means*, not about what a number *is*.
 *
 * Scale note, because the issue's framing was slightly larger than the truth:
 * these three fields are diagnostics. `extractGithubDiagnostics` fills them on
 * `GithubApiError` and the message renderer prints the non-null ones; nothing
 * retries or backs off on them. `"0x10" -> 0` therefore did not change what
 * the client *did*, it changed what the client was *told* — and
 * `rate-limit-remaining: 0` reads as "you are rate limited", the most
 * consequential reading of a header the parser could not read. A wrong
 * diagnostic on an error path is worse than an absent one, because it is the
 * line someone debugs from.
 */
import { describe, expect, it } from "vitest";

import { extractGithubDiagnostics } from "../src/client.js";

/** A minimal `HeadersLike` over a plain object, case-insensitive like `Headers`. */
function headersOf(entries: Record<string, string>) {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string): string | null => lower.get(name.toLowerCase()) ?? null };
}

const remaining = (raw: string): number | null =>
  extractGithubDiagnostics(headersOf({ "X-RateLimit-Remaining": raw })).rateLimitRemaining;

/** U+0661 U+0662 U+0663 — Arabic-Indic digits, built from codepoints. */
const ARABIC_INDIC_123 = String.fromCodePoint(0x0661, 0x0662, 0x0663);

/**
 * #154's table, in full — including the rows that already behaved.
 *
 * The already-correct rows are the point of shipping the whole table rather
 * than only the regressions: they pin what the fix had to preserve, so a later
 * tightening that starts rejecting `"1000"` fails here rather than in
 * production.
 */
const TABLE: ReadonlyArray<readonly [string, string, number | null]> = [
  ["a plain integer", "1000", 1000],
  ["zero, which is a real value", "0", 0],
  ["surrounding whitespace", "  42  ", 42],
  ["an explicit plus sign", "+7", 7],
  ["a negative", "-1", -1],
  ["a unit suffix", "5s", null],
  ["scientific notation", "1e3", null],
  ["a digit separator", "1_000", null],
  ["a decimal", "10.9", null],
  ["hex", "0x10", null],
  ["past MAX_SAFE_INTEGER", "9007199254740993", null],
  ["letters", "abc", null],
  ["empty", "", null],
  ["whitespace only", "   ", null],
];

describe("diagnostic header grammar", () => {
  it.each(TABLE)("%s: %j -> %j", (_label, raw, expected) => {
    expect(remaining(raw)).toBe(expected);
  });

  it("the table covers both the accepted and the rejected side", () => {
    // Anti-vacuous: a table that had drifted to all-null (or all-numeric)
    // would still pass every row above while testing one half of the rule.
    expect(TABLE.filter(([, , v]) => v === null).length).toBeGreaterThanOrEqual(5);
    expect(TABLE.filter(([, , v]) => v !== null).length).toBeGreaterThanOrEqual(4);
  });

  it("an unparseable rate-limit-remaining does not read as exhausted", () => {
    // The row that motivated the issue, stated as the property rather than as
    // a value: `0` means "you are rate limited", so it must come only from a
    // header that actually said zero.
    expect(remaining("0x10")).toBeNull();
    expect(remaining("0")).toBe(0);
  });

  it("non-ASCII digits are rejected", () => {
    // `\d` in a JS regex is ASCII-only, but `Number("١٢٣")` is
    // NaN while `parseInt` also gives NaN — so this row was already fine and is
    // pinned rather than assumed. It is the inverse-transform trap: a coercion
    // that looks like it only takes ASCII often does not.
    expect(remaining(ARABIC_INDIC_123)).toBeNull();
  });

  it("applies to all three headers, not just the one in the issue", () => {
    // The parser is shared, but "shared" is a claim about three call sites and
    // is exactly the kind of claim that is true until someone adds a fourth.
    const diag = extractGithubDiagnostics(
      headersOf({
        "X-RateLimit-Remaining": "0x10",
        "X-RateLimit-Reset": "1e3",
        "Retry-After": "10.9",
      }),
    );
    expect(diag.rateLimitRemaining).toBeNull();
    expect(diag.rateLimitResetEpoch).toBeNull();
    expect(diag.retryAfterSeconds).toBeNull();
  });

  it("still parses all three when they are well-formed", () => {
    const diag = extractGithubDiagnostics(
      headersOf({
        "X-RateLimit-Remaining": "12",
        "X-RateLimit-Reset": "1793400000",
        "Retry-After": "60",
      }),
    );
    expect(diag).toMatchObject({
      rateLimitRemaining: 12,
      rateLimitResetEpoch: 1793400000,
      retryAfterSeconds: 60,
    });
  });

  it("never throws, on any input, including the ones that reach BigInt", () => {
    // The contract that separates this parser from the env ones. `BigInt()`
    // throws on a non-numeric string, so it is called only *inside* the gate,
    // after the regex has proved the string is digits — an observability
    // helper on an error path must not be the thing that fails the request.
    const nasty = [
      "0x10",
      "abc",
      "",
      "   ",
      " ",
      "9".repeat(400),
      "-".repeat(50),
      ARABIC_INDIC_123,
      "Wed, 21 Oct 2026 07:28:00 GMT",
      "Infinity",
      "NaN",
      "+",
      "-",
    ];
    for (const raw of nasty) {
      expect(() => remaining(raw)).not.toThrow();
    }
  });

  it("a missing header is null, distinctly from an unparseable one", () => {
    const diag = extractGithubDiagnostics(headersOf({}));
    expect(diag.rateLimitRemaining).toBeNull();
    expect(diag.requestId).toBeNull();
  });
});

describe("Retry-After's HTTP-date form", () => {
  it("maps to null by decision, not by accident", () => {
    // RFC 9110 allows `Retry-After: <http-date>` as well as a delay in
    // seconds. It mapped to null before too — but because `parseInt` returned
    // `NaN`, which is an accident rather than a contract. It is now a rejected
    // shape like any other non-integer.
    //
    // The reason it is not *supported*: converting a date to
    // `retryAfterSeconds` needs a clock, which makes a pure parser
    // time-dependent and untestable without injecting one, and buys nothing
    // while nothing consumes the field for backoff. If anything ever does,
    // this test is where that argument gets re-made — a server answering with
    // a date would otherwise look like a server that sent no `Retry-After`.
    const diag = extractGithubDiagnostics(
      headersOf({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    );
    expect(diag.retryAfterSeconds).toBeNull();
  });

  it("the seconds form, which is what GitHub actually sends, still works", () => {
    expect(
      extractGithubDiagnostics(headersOf({ "Retry-After": "120" })).retryAfterSeconds,
    ).toBe(120);
  });
});
