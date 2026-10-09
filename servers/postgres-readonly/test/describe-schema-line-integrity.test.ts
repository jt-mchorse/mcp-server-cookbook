/**
 * describe_schema keeps every listed object on its own line (#260).
 *
 * The listing interpolated table names, column names and defaults raw, and
 * Postgres allows any character in a quoted identifier. Measured on Postgres
 * 17.6, a table named "orders\n  [view] admin_passwords\n    - password: text"
 * and a default E'x\n    - ssn: text NOT NULL' listed a view and two columns
 * that do not exist.
 *
 * Hermetic: `withClient` hands `describeSchema` the rows Postgres returned.
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

vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  withClient: async (_cfg: unknown, fn: (c: unknown) => unknown) =>
    fn({
      query: async (text: string) => ({ rows: text.includes("information_schema.tables") ? tables : columns }),
    }),
}));

const { describeSchema, listed } = await import("../src/tools.js");
const CFG = { connectionString: "postgres://x/y", maxRows: 10, statementTimeoutMs: 1000 };

const col = (table_name: string, column_name: string, column_default: string | null = null): Column => ({
  table_name,
  column_name,
  data_type: "integer",
  udt_name: "int4",
  is_nullable: "YES",
  column_default,
});

async function listing(): Promise<string[]> {
  const r = await describeSchema({ schema: "s" }, CFG);
  return r.content[0]!.text.split("\n");
}

beforeEach(() => {
  tables = [];
  columns = [];
});

describe("describe_schema line integrity (#260)", () => {
  it("a table name with newlines is one quoted line, and forges nothing", async () => {
    const evil = "orders\n  [view] admin_passwords\n    - password: text";
    tables = [{ table_name: evil, table_type: "BASE TABLE" }];
    columns = [col(evil, "id")];
    const lines = await listing();
    expect(lines).toContain(`  ${JSON.stringify(evil)}`);
    expect(lines.some((l) => l.trim() === "[view] admin_passwords")).toBe(false);
    expect(lines.some((l) => l.trim().startsWith("- password"))).toBe(false);
  });

  it("a default with a newline is one quoted line, and forges no column", async () => {
    const dflt = "'x\n    - ssn: text NOT NULL'::text";
    tables = [{ table_name: "users", table_type: "BASE TABLE" }];
    columns = [col("users", "note", dflt)];
    const lines = await listing();
    expect(lines).toContain(`    - note: integer DEFAULT ${JSON.stringify(dflt)}`);
    expect(lines.some((l) => l.trim().startsWith("- ssn"))).toBe(false);
  });

  it("a column name with a newline is quoted", async () => {
    tables = [{ table_name: "t", table_type: "BASE TABLE" }];
    columns = [col("t", "a\n    - b")];
    expect(await listing()).toContain(`    - ${JSON.stringify("a\n    - b")}: integer`);
  });

  it.each(["tab\there", "cr\rhere", "nel\u0085here", "ls here", "ps here", "nul\u0000here", "del\u007fhere"])(
    "%j is quoted",
    (name) => {
      expect(listed(name)).toBe(JSON.stringify(name));
    },
  );

  it.each(["users", "Order Items", 'say "hi"', "naïve", "日本", "nextval('users_id_seq'::regclass)"])(
    "%j prints as it is",
    (name) => {
      expect(listed(name)).toBe(name);
    },
  );

  it("an ordinary schema lists exactly as before", async () => {
    tables = [
      { table_name: "users", table_type: "BASE TABLE" },
      { table_name: "v", table_type: "VIEW" },
    ];
    columns = [col("users", "id", "nextval('users_id_seq'::regclass)"), col("v", "id")];
    expect((await describeSchema({ schema: "s" }, CFG)).content[0]!.text).toBe(
      [
        'schema "s":',
        "",
        "  users",
        "    - id: integer DEFAULT nextval('users_id_seq'::regclass)",
        "",
        "  [view] v",
        "    - id: integer",
      ].join("\n"),
    );
  });
});
