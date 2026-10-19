/**
 * `withClient` pins `standard_conforming_strings = on` before the tool's
 * query runs (#252).
 *
 * The guard lexes a plain '...' literal as standard SQL, where a backslash is
 * an ordinary character. The setting is inherited from the server, database
 * or role. Measured on Postgres 17.6 after `ALTER ROLE postgres SET
 * standard_conforming_strings = off`, through `runSelect` on `main`:
 *
 *   SELECT '\'', pg_sleep(2), txid_current() --'
 *     -> guard ok, ran in 2009 ms
 *   SELECT '\''; COMMIT; BEGIN READ WRITE; DROP TABLE victim; COMMIT; --'
 *     -> guard ok, table dropped
 *
 * The suite is hermetic, so `pg.Client` is replaced by a recorder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const issued: string[] = [];
let failOn: string | undefined;

vi.mock("pg", () => {
  class Client {
    async connect() {
      issued.push("<connect>");
    }
    async query(text: string) {
      issued.push(text);
      if (failOn !== undefined && text.includes(failOn)) throw new Error(`refused: ${text}`);
      return { rows: [] };
    }
    async end() {
      issued.push("<end>");
    }
  }
  return { default: { Client } };
});

const { withClient } = await import("../src/db.js");

const CFG = { connectionString: "postgresql://reader@localhost/x", maxRows: 10, statementTimeoutMs: 1000 };

beforeEach(() => {
  issued.length = 0;
  failOn = undefined;
});

describe("withClient session pins (#252)", () => {
  it("sets standard_conforming_strings = on before the caller's query", async () => {
    await withClient(CFG, async (c) => c.query("SELECT '\\''"));
    const pin = issued.indexOf("SET standard_conforming_strings = on");
    expect(pin).toBeGreaterThan(issued.indexOf("<connect>"));
    expect(pin).toBeLessThan(issued.indexOf("SELECT '\\''"));
  });

  it("keeps the other pins, all of them before the caller's query", async () => {
    await withClient(CFG, async (c) => c.query("SELECT 1"));
    expect(issued).toEqual([
      "<connect>",
      "SET statement_timeout = 1000",
      "SET default_transaction_read_only = on",
      "SET standard_conforming_strings = on",
      "SET DateStyle = ISO",
      "SET IntervalStyle = postgres",
      "SELECT 1",
      "<end>",
    ]);
  });

  it("never runs the caller's query when the pin is refused", async () => {
    failOn = "standard_conforming_strings";
    const fn = vi.fn(async () => "ran");
    await expect(withClient(CFG, fn)).rejects.toThrow(/refused/);
    expect(fn).not.toHaveBeenCalled();
    expect(issued.at(-1)).toBe("<end>");
  });
});

/**
 * `withClient` pins the output formats the result parsers read (#299).
 *
 * pg's timestamptz and interval parsers understand only the ISO DateStyle and
 * the `postgres` IntervalStyle, and both settings are inherited from the
 * server, database or role. Measured on Postgres 17 through `sampleRows` on
 * `main`: a role with DateStyle 'SQL, DMY', 'German' or 'Postgres, MDY' got
 * every timestamptz as null; a role with IntervalStyle 'iso_8601' got
 * `1 day 02:03:04.5` as `{}`, the same value as a zero interval.
 */
describe("withClient output-format pins (#299)", () => {
  it.each(["SET DateStyle = ISO", "SET IntervalStyle = postgres"])(
    "issues %s after connecting and before the caller's query",
    async (pin) => {
      await withClient(CFG, async (c) => c.query("SELECT now(), interval '1 day'"));
      const at = issued.indexOf(pin);
      expect(at).toBeGreaterThan(issued.indexOf("<connect>"));
      expect(at).toBeLessThan(issued.indexOf("SELECT now(), interval '1 day'"));
    },
  );

  it.each(["DateStyle", "IntervalStyle"])(
    "never runs the caller's query when the %s pin is refused",
    async (setting) => {
      failOn = setting;
      const fn = vi.fn(async () => "ran");
      await expect(withClient(CFG, fn)).rejects.toThrow(/refused/);
      expect(fn).not.toHaveBeenCalled();
      expect(issued.at(-1)).toBe("<end>");
    },
  );
});
