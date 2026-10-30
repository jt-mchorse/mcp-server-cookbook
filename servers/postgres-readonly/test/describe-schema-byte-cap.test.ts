/**
 * `describe_schema` is bounded by MAX_RESULT_BYTES like the other two tools (#366).
 *
 * #347 capped `run_select` and `sample_rows` only. Measured on PostgreSQL 17.6,
 * a schema whose one table has four text columns, each defaulting to 16.5M
 * U+0001 characters, made `describe_schema` one 396,000,155-character listing:
 * Node 25 exited 134 in JSON.stringify, and on Node 20/22 the call was never
 * answered. `listed()` JSON-quotes a control character as six bytes, so the
 * listing is counted after quoting as well as the rows in Postgres.
 *
 * Hermetic: `withClient` hands `describeSchema` a client that answers the
 * catalog queries the way Postgres does, including the byte-capped wrapper's
 * cast error once the rows' running total passes the cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Table = { table_name: string; table_type: string };
type Column = {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
};
let tables: Table[] = [];
let columns: Column[] = [];
let sent: Array<{ text: string; values: unknown }> = [];
let throwOnColumns: Error | undefined;

/** The wrapper's cap and nonce, as Postgres would read them from the SQL. */
function capOf(text: string): { cap: number; nonce: string } | undefined {
  const m = text.match(/AS mcp_bytes_([0-9a-f]+) FROM \([\s\S]*> (\d+) THEN/);
  return m ? { nonce: m[1]!, cap: Number(m[2]) } : undefined;
}

vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  withClient: async (_cfg: unknown, fn: (c: unknown) => unknown) =>
    fn({
      query: async (text: string, values: unknown) => {
        sent.push({ text, values });
        const isTables = text.includes("information_schema.tables");
        if (!isTables && throwOnColumns) throw throwOnColumns;
        const rows: Array<Record<string, unknown>> = isTables ? tables : columns;
        const w = capOf(text);
        if (!w) return { rows };
        // Postgres's running total of each row's text, and the cast error the
        // wrapper raises at the first row past the cap.
        let total = 0;
        for (const r of rows) {
          total += Object.values(r).reduce<number>((n, v) => n + (v === null ? 0 : Buffer.byteLength(String(v))), 0);
          if (total > w.cap) throw new Error(`invalid input syntax for type integer: "${w.nonce}:${total}"`);
        }
        return { rows: rows.map((r) => ({ ...r, [`mcp_bytes_${w.nonce}`]: String(total) })) };
      },
    }),
}));

const { describeSchema } = await import("../src/tools.js");
const { DEFAULT_MAX_RESULT_BYTES, ResultTooLargeError } = await import("../src/db.js");
const CFG = { connectionString: "postgres://x/y", maxRows: 10, statementTimeoutMs: 1000 };
const MIB = 1024 * 1024;

const col = (table_name: string, column_name: string, column_default: string | null = null): Column => ({
  table_name,
  column_name,
  data_type: "text",
  udt_name: "text",
  is_nullable: "YES",
  column_default,
});

beforeEach(() => {
  tables = [];
  columns = [];
  sent = [];
  throwOnColumns = undefined;
});

describe("describe_schema under MAX_RESULT_BYTES (#366)", () => {
  it("the four-column control-character schema is answered with the cap error", async () => {
    // The issue's shape at a 1 MiB cap: 4 x 300,000 bytes of defaults pass
    // the cap in Postgres at the fourth row.
    const dflt = `'${"\u0001".repeat(300_000)}'::text`;
    tables = [{ table_name: "t", table_type: "BASE TABLE" }];
    columns = ["c1", "c2", "c3", "c4"].map((c) => col("t", c, dflt));
    const r = await describeSchema({ schema: "four" }, { ...CFG, maxResultBytes: MIB });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(
      /^result too large: the rows read so far total \d+ bytes as text, over the MAX_RESULT_BYTES cap of 1048576 bytes/,
    );
    expect(r.content[0]!.text).toContain("information_schema.columns through run_select");
    expect(r.content[0]!.text.length).toBeLessThan(1000);
  });

  it("rows under the cap that render past it after quoting are refused", async () => {
    // 200,000 bytes in Postgres, 1,200,000 once each U+0001 is written `\u0001`.
    tables = [{ table_name: "t", table_type: "BASE TABLE" }];
    columns = [col("t", "c1", "\u0001".repeat(200_000))];
    const r = await describeSchema({ schema: "one" }, { ...CFG, maxResultBytes: MIB });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(
      /^result too large: the listing built so far totals \d+ bytes, over the MAX_RESULT_BYTES cap of 1048576 bytes \(#366\)/,
    );
  });

  it("both catalog queries run inside the byte-capped wrapper, at the default cap when unset", async () => {
    tables = [{ table_name: "t", table_type: "BASE TABLE" }];
    columns = [col("t", "a")];
    await describeSchema({ schema: "s" }, CFG);
    expect(sent).toHaveLength(2);
    for (const q of sent) {
      expect(capOf(q.text)?.cap).toBe(DEFAULT_MAX_RESULT_BYTES);
      expect(q.values).toEqual(["s"]);
    }
  });

  it("the listing's count is its exact UTF-8 byte length, newlines included", async () => {
    tables = [{ table_name: "日本", table_type: "BASE TABLE" }];
    columns = [col("日本", "naïve", "'x'::text"), col("日本", "b")];
    const whole = await describeSchema({ schema: "s" }, { ...CFG, maxResultBytes: MIB });
    const size = Buffer.byteLength(whole.content[0]!.text);
    expect(size).toBeGreaterThan(whole.content[0]!.text.length);
    const atCap = await describeSchema({ schema: "s" }, { ...CFG, maxResultBytes: size });
    expect(atCap).toEqual(whole);
    const under = await describeSchema({ schema: "s" }, { ...CFG, maxResultBytes: size - 1 });
    expect(under.isError).toBe(true);
    expect(under.content[0]!.text).toContain(`totals ${size} bytes`);
  });

  it("a reply the wire guard refused is the tool's isError", async () => {
    tables = [{ table_name: "t", table_type: "BASE TABLE" }];
    throwOnColumns = new ResultTooLargeError("result too large: the database sent a 99999999-byte row");
    const r = await describeSchema({ schema: "s" }, CFG);
    expect(r).toEqual({
      content: [{ type: "text", text: "result too large: the database sent a 99999999-byte row" }],
      isError: true,
    });
  });

  // Controls: what the cap must leave alone.
  it("any other query error still propagates to the handler", async () => {
    tables = [{ table_name: "t", table_type: "BASE TABLE" }];
    throwOnColumns = new Error("permission denied for schema s");
    await expect(describeSchema({ schema: "s" }, CFG)).rejects.toThrow("permission denied for schema s");
  });

  it("an ordinary schema lists byte-identically", async () => {
    tables = [
      { table_name: "users", table_type: "BASE TABLE" },
      { table_name: "v", table_type: "VIEW" },
    ];
    columns = [
      { ...col("users", "id", "nextval('users_id_seq'::regclass)"), data_type: "integer", udt_name: "int4", is_nullable: "NO" },
      col("users", "email"),
      col("v", "email"),
    ];
    const r = await describeSchema({ schema: "public" }, CFG);
    expect(r).toEqual({
      content: [
        {
          type: "text",
          text:
            'schema "public":\n\n  users\n' +
            "    - id: integer NOT NULL DEFAULT nextval('users_id_seq'::regclass)\n" +
            "    - email: text\n\n  [view] v\n    - email: text",
        },
      ],
    });
  });

  it("a schema with no tables is answered as before", async () => {
    const r = await describeSchema({ schema: "empty" }, CFG);
    expect(r).toEqual({ content: [{ type: "text", text: 'schema "empty" has no tables or views' }] });
  });
});
