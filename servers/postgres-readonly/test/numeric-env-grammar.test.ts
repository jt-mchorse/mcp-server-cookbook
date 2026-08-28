/**
 * `MAX_ROWS` / `STATEMENT_TIMEOUT_MS` accept a positive integer, and only that (#152).
 *
 * These were read through `Number.parseInt(raw, 10)`, which stops at the first
 * character it cannot consume and returns what it has — so the parser accepted
 * a far larger language than "a positive integer", and the error message said
 * the value *was* one when it wasn't.
 *
 * The dangerous rows are the duration ones. `STATEMENT_TIMEOUT_MS` is a
 * duration, and the natural way to write a duration is with a unit: an operator
 * setting `5s` means five seconds and got **five milliseconds** — 1000x tighter
 * — with every query then failing and the config still reading `5s`. `1000ms`
 * was correct by coincidence, which is worse, because it teaches that the
 * suffix is understood.
 *
 * `MAX_ROWS` is a security-relevant cap; it took `10.9` as `10` and `1_000` as
 * `1`.
 */
import { afterEach, describe, expect, it } from "vitest";

import { readDbConfigFromEnv } from "../src/db.js";

const SAVED = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

function withEnv(vars: Record<string, string | undefined>): void {
  process.env.DATABASE_URL = "postgres://ro@localhost/db";
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Every row #152 measured as wrongly accepted, plus the precision one. */
const REJECTED = [
  "5s",
  "30m",
  "1000ms",
  "5 seconds",
  "1e3",
  "1e10",
  "1_000",
  "10.9",
  "0x10",
  "abc",
  "",
  "  ",
  "9007199254740993",
  "-5",
  "0",
] as const;

describe.each(["MAX_ROWS", "STATEMENT_TIMEOUT_MS"])("%s", (name) => {
  it.each(REJECTED)("rejects %j", (raw) => {
    withEnv({ [name]: raw });
    expect(() => readDbConfigFromEnv()).toThrow(/must be a positive integer/);
  });

  it("names the variable and the raw value it was given", () => {
    // The old message asserted the value was a positive integer. The point of
    // the fix is that the message is now true, so it has to carry the input.
    withEnv({ [name]: "5s" });
    expect(() => readDbConfigFromEnv()).toThrow(new RegExp(`${name}[\\s\\S]*"5s"`));
  });

  it("accepts a plain positive integer", () => {
    withEnv({ [name]: "1234" });
    expect(() => readDbConfigFromEnv()).not.toThrow();
  });

  it.each([
    ["1234", 1234],
    [" 1234 ", 1234],
    ["+7", 7],
    ["007", 7],
  ])("accepts %j as %i", (raw, expected) => {
    // Whitespace is trimmed rather than rejected — a deliberate divergence from
    // #152's proposed `String(n) !== raw`, which would refuse `" 7 "`. A value
    // from a `.env` line or a YAML block routinely carries whitespace, and
    // trimming reopens none of the rejected rows above (`" 5s"` still throws).
    withEnv({ [name]: raw as string });
    const cfg = readDbConfigFromEnv();
    const actual = name === "MAX_ROWS" ? cfg.maxRows : cfg.statementTimeoutMs;
    expect(actual).toBe(expected);
  });

  it("falls back to its default when unset", () => {
    withEnv({ [name]: undefined });
    expect(() => readDbConfigFromEnv()).not.toThrow();
  });
});

it("a padded value that is otherwise invalid still throws", () => {
  // Anti-vacuous for the trimming decision: trimming must not become a way in.
  withEnv({ MAX_ROWS: "  5s  " });
  expect(() => readDbConfigFromEnv()).toThrow(/must be a positive integer/);
});
