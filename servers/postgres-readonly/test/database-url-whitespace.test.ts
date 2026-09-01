/**
 * `DATABASE_URL` is trimmed and gated on content, not on falsiness (#157).
 *
 * `readDbConfigFromEnv` guarded with `if (!connectionString)` and never
 * trimmed; `validateDbConfig` re-checked `length === 0`. A whitespace-only
 * value is truthy and non-zero-length, and so is a valid connection string
 * carrying one stray space — the shape a `.env` line or a YAML block routinely
 * produces.
 *
 * The observable that matters is not "an error is thrown". It is **where the
 * connection would have gone**, so that is what this file asserts. Measured on
 * `new Client({ connectionString }).connectionParameters` in a clean
 * environment with no `PG*` variables set:
 *
 *     "postgres://u:p@h:5432/db"    -> host "h",    database "db",  user "u"
 *     " postgres://u:p@h:5432/db "  -> host "base", database " postgres://u:p@h:5432/db "
 *     "   "                         -> host "base", database "   "
 *     ""                            -> host "localhost"
 *
 * One space and `pg` stops parsing the string as a URL, falls back to
 * keyword/value parsing, and connects to a different host with the whole
 * connection string as the database name and no user — i.e. as the process's
 * OS user. `readDbConfigFromEnv`'s own error message calls the read-only role
 * "your defense-in-depth"; with a stray space the role is not used at all.
 *
 * Note the `""` row is the one `validateDbConfig`'s comment already documents
 * as worth guarding, and it is the *least* dangerous of the four.
 */
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { readDbConfigFromEnv, validateDbConfig, type DbConfig } from "../src/db.js";

const VALID = "postgres://u:p@h:5432/db";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Where `pg` would actually connect for a given connection string. */
function resolvedTarget(connectionString: string): {
  host: unknown;
  database: unknown;
  user: unknown;
} {
  const p = new Client({ connectionString }).connectionParameters as unknown as Record<
    string,
    unknown
  >;
  return { host: p.host, database: p.database, user: p.user };
}

function baseEnv(databaseUrl: string): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MAX_ROWS;
  delete process.env.STATEMENT_TIMEOUT_MS;
  process.env.DATABASE_URL = databaseUrl;
}

describe("pg's own behaviour, pinned — the reason this fix exists", () => {
  it("does not parse a padded connection string as a URL", () => {
    // If `pg` ever starts trimming for us, this row moves and the fix becomes
    // belt-and-braces rather than load-bearing. Better to learn that here than
    // to keep asserting a consequence that stopped happening.
    const clean = resolvedTarget(VALID);
    const padded = resolvedTarget(` ${VALID} `);
    expect(clean.host).toBe("h");
    expect(clean.database).toBe("db");
    expect(padded.host).not.toBe("h");
    expect(padded.database).toBe(` ${VALID} `);
    expect(padded.user).not.toBe("u");
  });

  it("resolves a whitespace-only string to somewhere, rather than failing", () => {
    // The silent part. Nothing throws; it just goes elsewhere.
    const target = resolvedTarget("   ");
    expect(target.host).toBeTruthy();
    expect(target.database).toBe("   ");
  });
});

// (label, DATABASE_URL value, accepted?). The padded row is the one that must
// be *accepted and normalized*, not rejected: refusing it would be a second
// wrong answer for an operator whose connection string is fine.
const ENV_CASES: ReadonlyArray<readonly [string, string, boolean]> = [
  ["a valid connection string", VALID, true],
  ["a valid string with a leading space", ` ${VALID}`, true],
  ["a valid string with a trailing space", `${VALID} `, true],
  ["a valid string with a trailing newline", `${VALID}\n`, true],
  ["a valid string padded both ends", ` ${VALID} `, true],
  ["spaces only", "   ", false],
  ["a tab and a newline", "\t\n", false],
  ["empty", "", false],
];

describe("readDbConfigFromEnv", () => {
  it("the case table covers both verdicts", () => {
    expect(ENV_CASES.filter(([, , ok]) => ok).length).toBeGreaterThanOrEqual(4);
    expect(ENV_CASES.filter(([, , ok]) => !ok).length).toBeGreaterThanOrEqual(3);
  });

  it.each(ENV_CASES)("%s", (label, value, accepted) => {
    baseEnv(value);
    if (!accepted) {
      expect(() => readDbConfigFromEnv()).toThrow(/DATABASE_URL is required/);
      return;
    }
    const cfg = readDbConfigFromEnv();
    // Not "it did not throw" — the padded forms must resolve to the SAME place
    // the clean one does. That is the whole defect.
    expect(resolvedTarget(cfg.connectionString)).toEqual(resolvedTarget(VALID));
    expect(cfg.connectionString).toBe(VALID);
  });

  it("a blank value is refused exactly like an unset one", () => {
    // Same message, so an operator whose `.env` line lost its value gets the
    // instruction rather than a connection to somewhere unexpected.
    process.env = { ...ORIGINAL_ENV };
    delete process.env.DATABASE_URL;
    let unsetMessage = "";
    try {
      readDbConfigFromEnv();
    } catch (e) {
      unsetMessage = (e as Error).message;
    }
    baseEnv("   ");
    let blankMessage = "";
    try {
      readDbConfigFromEnv();
    } catch (e) {
      blankMessage = (e as Error).message;
    }
    expect(unsetMessage).not.toBe("");
    expect(blankMessage).toBe(unsetMessage);
  });
});

describe("validateDbConfig, the programmatic seam", () => {
  const cfgWith = (connectionString: string): DbConfig => ({
    connectionString,
    maxRows: 10,
    statementTimeoutMs: 100,
  });

  it.each([
    ["empty", ""],
    ["spaces only", "   "],
    ["a tab", "\t"],
    ["a newline", "\n"],
  ])("rejects %s", (label, value) => {
    expect(() => validateDbConfig(cfgWith(value))).toThrow(/non-empty string/);
  });

  it("still accepts an ordinary connection string", () => {
    // Anti-vacuous: a guard that rejected everything would satisfy the rows
    // above, and "no config is valid" is not the fix.
    expect(() => validateDbConfig(cfgWith(VALID))).not.toThrow();
  });

  it("accepts a padded string, because the env reader has already trimmed it", () => {
    // Deliberate scope note: the programmatic seam gates on *content*, not on
    // canonical form. Rejecting a padded string here would refuse a caller who
    // built a `DbConfig` by hand from a value that is perfectly usable — and
    // `pg` mis-resolving it is a reason to normalize at the read seam, which is
    // where the normalization lives.
    expect(() => validateDbConfig(cfgWith(` ${VALID} `))).not.toThrow();
  });
});

describe("the two env reads in one function agree about whitespace", () => {
  // The sharpest form of this finding: inside a single `readDbConfigFromEnv`
  // call, `MAX_ROWS` and `STATEMENT_TIMEOUT_MS` trimmed and gated while
  // `DATABASE_URL` did neither. `parseIntEnv`'s docstring argues for trimming
  // in the same module — "a value read from a `.env` line or a YAML block
  // routinely carries whitespace" — and that argument was never applied to the
  // string. Driving all three off one table is what stops them drifting apart
  // again.
  const PADDINGS = [" ", "\t", "\n", " \t\n "] as const;

  it.each(PADDINGS)("padding %j is tolerated on every setting", (pad) => {
    process.env = { ...ORIGINAL_ENV };
    process.env.DATABASE_URL = `${pad}${VALID}${pad}`;
    process.env.MAX_ROWS = `${pad}25${pad}`;
    process.env.STATEMENT_TIMEOUT_MS = `${pad}250${pad}`;
    const cfg = readDbConfigFromEnv();
    expect(cfg.connectionString).toBe(VALID);
    expect(cfg.maxRows).toBe(25);
    expect(cfg.statementTimeoutMs).toBe(250);
  });

  it.each(PADDINGS)("padding %j alone is rejected on every setting", (pad) => {
    // The other half: whitespace *instead of* a value must fail on all three,
    // not merely be tolerated on all three.
    process.env = { ...ORIGINAL_ENV };
    process.env.DATABASE_URL = pad;
    expect(() => readDbConfigFromEnv()).toThrow(/DATABASE_URL is required/);

    baseEnv(VALID);
    process.env.MAX_ROWS = pad;
    expect(() => readDbConfigFromEnv()).toThrow(/MAX_ROWS/);

    baseEnv(VALID);
    process.env.STATEMENT_TIMEOUT_MS = pad;
    expect(() => readDbConfigFromEnv()).toThrow(/STATEMENT_TIMEOUT_MS/);
  });
});
