/**
 * Hermetic unit tests for `describe_schema`'s column-type resolution (#86).
 *
 * `describe_schema`'s columns query originally selected only
 * `information_schema.columns.data_type`, which is the literal string
 * `USER-DEFINED` for enum/domain/composite columns and `ARRAY` for array
 * columns — so the shipped sample-db's `orders.status order_status` enum
 * rendered as `USER-DEFINED`. The real type name lives in `udt_name`.
 *
 * These tests pin the pure mapping (`formatColumnType`) rather than run a
 * live Postgres — the server's suite is deliberately hermetic (see
 * `db.test.ts`: "no real Postgres needed"). The `data_type`/`udt_name`
 * pairs below are the exact values Postgres 16 returns for the sample-db
 * schema (verified firsthand against an ephemeral PG16 container).
 */

import { describe, expect, it } from "vitest";

import type { DbConfig } from "../src/db.js";
import { describeSchema, formatColumnType, sampleRows } from "../src/tools.js";

// A cfg that must never be reached: these tests exercise the identifier guard,
// which returns before `withClient` ever connects. If a non-string arg slipped
// past the guard the call would try to dial this bogus DSN and fail loudly,
// so "returns a clean isError result naming the identifier" is the assertion.
const UNREACHABLE_CFG: DbConfig = {
  connectionString: "postgres://unreachable.invalid:1/none",
  maxRows: 10,
  statementTimeoutMs: 1000,
};

describe("formatColumnType", () => {
  it("uses udt_name for a USER-DEFINED (enum/domain/composite) column", () => {
    // orders.status -> data_type USER-DEFINED, udt_name order_status
    expect(formatColumnType("USER-DEFINED", "order_status")).toBe("order_status");
  });

  it("renders an ARRAY column as <element>[] from the underscore-prefixed udt_name", () => {
    // tags int[] -> data_type ARRAY, udt_name _int4
    expect(formatColumnType("ARRAY", "_int4")).toBe("int4[]");
  });

  it("defensively renders an ARRAY udt_name without a leading underscore as <name>[]", () => {
    expect(formatColumnType("ARRAY", "int4")).toBe("int4[]");
  });

  it("keeps the SQL-standard data_type for a built-in integer column", () => {
    // id integer -> data_type integer, udt_name int4 (data_type is friendlier)
    expect(formatColumnType("integer", "int4")).toBe("integer");
  });

  it("keeps the SQL-standard data_type for a timestamptz column", () => {
    // created_at timestamptz -> data_type "timestamp with time zone", udt_name timestamptz
    expect(formatColumnType("timestamp with time zone", "timestamptz")).toBe(
      "timestamp with time zone",
    );
  });

  it("keeps the SQL-standard data_type for a text column", () => {
    expect(formatColumnType("text", "text")).toBe("text");
  });
});

// #122: non-string schema/table bypassed the IDENT_RE guard via String()
// coercion (`IDENT_RE.test(["users"])` -> String(["users"]) === "users" -> true;
// `true` -> "true"; `null` -> "null"). A 1-element array like `["users"]` would
// then actually query the real table. The guard now rejects any non-string
// identifier before coercion, mirroring the #117/#119 non-string-arg fixes.
// These are hermetic: the guard returns before `withClient` ever connects.
describe("describeSchema — non-string schema is rejected (#122)", () => {
  for (const bad of [["public"], true, 42, { s: "public" }] as unknown[]) {
    it(`rejects schema=${JSON.stringify(bad)} with a clean isError result`, async () => {
      const res = await describeSchema({ schema: bad as string | undefined }, UNREACHABLE_CFG);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/schema name must match/);
    });
  }
});

describe("sampleRows — non-string table/schema is rejected (#122)", () => {
  for (const bad of [["users"], true, null, 7, { t: "users" }] as unknown[]) {
    it(`rejects table=${JSON.stringify(bad)} with a clean isError result`, async () => {
      const res = await sampleRows({ table: bad as string }, UNREACHABLE_CFG);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/table name must match/);
    });
  }

  it("rejects a non-string schema even with a valid table", async () => {
    const res = await sampleRows(
      { schema: ["public"] as unknown as string, table: "users" },
      UNREACHABLE_CFG,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/schema name must match/);
  });
});
