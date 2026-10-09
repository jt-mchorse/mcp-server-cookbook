import { randomUUID } from "node:crypto";
import pg from "pg";
import { type DbConfig, withClient } from "./db.js";
import { guardQuery } from "./sqlGuard.js";
import { exactTimestamptzParser } from "./timestamptz.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/* ------------------------------------------------------------------ */
/* describe_schema                                                     */
/* ------------------------------------------------------------------ */

export interface DescribeSchemaArgs {
  /** Optional schema name. Default 'public'. Must be a single bare identifier. */
  schema?: string;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve the display type name for a column from its
 * `information_schema.columns` row.
 *
 * `data_type` is the SQL-standard type name for built-in scalars
 * (`integer`, `timestamp with time zone`) — friendly and worth keeping.
 * But for a user-defined type (enum, domain, composite) it is the
 * literal string `USER-DEFINED`, and for an array it is `ARRAY`; in
 * both cases the real type name lives only in `udt_name` (pg's internal
 * type name). Selecting `data_type` alone therefore loses the type for
 * every enum/domain/composite/array column — e.g. the sample-db's
 * `orders.status order_status` renders as `USER-DEFINED` (#86).
 *
 * So: prefer `udt_name` when `data_type` is uninformative, and render an
 * array as `<element>[]`. pg names an array type as its element type
 * with a leading underscore (`_int4` for `int4[]`), so strip that.
 */
export function formatColumnType(dataType: string, udtName: string): string {
  if (dataType === "USER-DEFINED") return udtName;
  if (dataType === "ARRAY") {
    const elem = udtName.startsWith("_") ? udtName.slice(1) : udtName;
    return `${elem}[]`;
  }
  return dataType;
}

/**
 * A name or default as `describe_schema` lists it (#260): as-is, unless it
 * holds a character that ends or bends a line -- a C0/C1 control, U+2028 or
 * U+2029 -- and then JSON-quoted. The listing is one object per line, and
 * Postgres allows any character in a quoted identifier and any expression as a
 * default: `"orders\n  [view] admin_passwords\n    - password: text"` listed
 * a view and a column that do not exist. Same rule as filesystem-sandbox's
 * quoted paths.
 */
export function listed(text: string): string {
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text) ? JSON.stringify(text) : text;
}

export async function describeSchema(args: DescribeSchemaArgs, cfg: DbConfig): Promise<ToolResult> {
  const schema = args.schema ?? "public";
  // `typeof` first: `IDENT_RE.test(x)` coerces via String(x), so a non-string
  // schema (`true` -> "true", `["public"]` -> "public") slips past the regex.
  // Reject before coercion, mirroring the #117/#119 non-string-arg guards.
  if (typeof schema !== "string" || !IDENT_RE.test(schema)) {
    return err(`schema name must match ${IDENT_RE.source}; got ${JSON.stringify(schema)}`);
  }

  return withClient(cfg, async (c) => {
    const tables = await c.query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type IN ('BASE TABLE', 'VIEW')
        ORDER BY table_name`,
      [schema],
    );

    if (tables.rows.length === 0) {
      return ok(`schema "${schema}" has no tables or views`);
    }

    const columns = await c.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1
        ORDER BY table_name, ordinal_position`,
      [schema],
    );

    const byTable = new Map<string, typeof columns.rows>();
    for (const row of columns.rows) {
      const list = byTable.get(row.table_name) ?? [];
      list.push(row);
      byTable.set(row.table_name, list);
    }

    const lines: string[] = [`schema "${schema}":`];
    for (const t of tables.rows) {
      const cols = byTable.get(t.table_name) ?? [];
      lines.push(`\n  ${t.table_type === "VIEW" ? "[view] " : ""}${listed(t.table_name)}`);
      for (const col of cols) {
        const nullable = col.is_nullable === "YES" ? "" : " NOT NULL";
        const dflt = col.column_default ? ` DEFAULT ${listed(col.column_default)}` : "";
        const type = formatColumnType(col.data_type, col.udt_name);
        lines.push(`    - ${listed(col.column_name)}: ${listed(type)}${nullable}${dflt}`);
      }
    }
    return ok(lines.join("\n"));
  });
}

/* ------------------------------------------------------------------ */
/* run_select                                                          */
/* ------------------------------------------------------------------ */

export interface RunSelectArgs {
  sql: string;
}

/* ------------------------------------------------------------------ */
/* payload fidelity (#207)                                             */
/* ------------------------------------------------------------------ */

// `date` and `timestamp` (no time zone) name a calendar value, not an instant.
// pg's default parser turned them into a JS `Date` at the SERVER's local time,
// and JSON wrote that as UTC: `2024-01-01` came back as
// `2023-12-31T23:00:00.000Z` under TZ=Europe/Berlin. Keep the database's own
// text. `timestamptz` IS an instant and keeps pg's instant (#249). The array forms
// reuse pg's text[] parser so they stay JS arrays, of the raw strings.
const DATE_OIDS = new Set([1082, 1114]);
const DATE_ARRAY_OIDS = new Set([1182, 1115]);
const TEXT_ARRAY_OID = 1009;

// pg's own parsers, except that `timestamptz` and its array keep the
// database's microseconds and a year past `Date`'s range (#249).
const pgParser = exactTimestamptzParser;

// `json` and `jsonb` (#247). pg's default parser is `JSON.parse`, which turns
// every number into a double: `{"id": 12345678901234567891}` came back as
// `12345678901234567000` and `1e400` (a valid jsonb numeric) as `Infinity`, then
// `"Infinity"` through `nonFiniteAsString`, and a `json` value's repeated key
// lost all but its last value. A `numeric` column keeps the same id exactly,
// because pg hands it back as text. The database's JSON text is kept here, and
// `stringifyPayload` writes it into the payload verbatim, so a client still
// receives a nested object or array.
const JSON_OIDS = new Set([114, 3802]);
const JSON_ARRAY_OIDS = new Set([199, 3807]);

/** A `json`/`jsonb` value as the database's own JSON text (#247). */
export class RawJson {
  constructor(readonly text: string) {}
}

function rawJsonElements(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rawJsonElements);
  return typeof value === "string" ? new RawJson(value) : value;
}

export const SELECT_TYPES = {
  getTypeParser(oid: number, format?: string): (value: string) => unknown {
    if (DATE_OIDS.has(oid)) return (value: string) => value;
    if (DATE_ARRAY_OIDS.has(oid)) return pgParser(TEXT_ARRAY_OID, format ?? "text");
    if (JSON_OIDS.has(oid)) return (value: string) => new RawJson(value);
    if (JSON_ARRAY_OIDS.has(oid)) {
      const parseTextArray = pgParser(TEXT_ARRAY_OID, format ?? "text");
      return (value: string) => rawJsonElements(parseTextArray(value));
    }
    return pgParser(oid, format ?? "text");
  },
};

/**
 * `JSON.stringify` replacer: a non-finite number is written as its name.
 * `NaN`/`Infinity` from a float column otherwise became `null`, which a client
 * cannot tell from SQL NULL (#207).
 */
export function nonFiniteAsString(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

/**
 * The tool payload as pretty-printed JSON, with every `RawJson` written as the
 * database's text rather than re-serialised (#247).
 *
 * Each `RawJson` is first stringified as a placeholder carrying a per-call
 * random nonce, which no database value can predict, and the placeholder's
 * quoted form is then replaced by the raw text. That text is valid JSON because
 * Postgres validated it on input, so the payload stays one valid JSON document.
 */
export function stringifyPayload(payload: unknown): string {
  const nonce = randomUUID();
  const raws: string[] = [];
  const text = JSON.stringify(
    payload,
    (key: string, value: unknown) => {
      if (value instanceof RawJson) {
        raws.push(value.text);
        return `${nonce}:${raws.length - 1}`;
      }
      return nonFiniteAsString(key, value);
    },
    2,
  );
  if (raws.length === 0) return text;
  return text.replace(new RegExp(`"${nonce}:(\\d+)"`, "g"), (_m, i: string) => raws[Number(i)]!);
}

/**
 * The output column names that occur more than once, or `[]`.
 *
 * Rows are objects keyed by column name, so `SELECT u.id, o.id ...` kept ONE
 * of the two values while `fields` listed both (#207) -- the model then read
 * the order id as the user id. Refused rather than renamed: an invented key is
 * a name the query never produced.
 */
export function duplicateColumnNames(fields: ReadonlyArray<{ name: string }> | undefined): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const f of fields ?? []) {
    if (seen.has(f.name)) dup.add(f.name);
    seen.add(f.name);
  }
  return [...dup];
}

export async function runSelect(args: RunSelectArgs, cfg: DbConfig): Promise<ToolResult> {
  const guard = guardQuery(args.sql);
  if (!guard.ok) {
    return err(`query rejected by guard: ${guard.reason}`);
  }

  return withClient(cfg, async (c) => {
    let result;
    try {
      // Append LIMIT cfg.maxRows + 1 if the query has no LIMIT? No — that's a
      // quietly-modify-the-query semantic the operator probably doesn't want.
      // Instead, fetch through the regular client and truncate afterward.
      // The DB-side statement_timeout (set in withClient) bounds runtime.
      result = await c.query({ text: args.sql, types: SELECT_TYPES });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`query execution error: ${msg}`);
    }

    const dups = duplicateColumnNames(result.fields);
    if (dups.length > 0) {
      return err(
        `query returns more than one column named ${dups.map((d) => JSON.stringify(d)).join(", ")}; ` +
          `rows are keyed by column name, so all but one value would be lost -- alias them ` +
          `(e.g. SELECT u.id AS user_id, o.id AS order_id ...)`,
      );
    }
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const truncated = rows.length > cfg.maxRows;
    const visible = truncated ? rows.slice(0, cfg.maxRows) : rows;

    const payload = {
      row_count: visible.length,
      truncated,
      max_rows: cfg.maxRows,
      fields: result.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) ?? [],
      rows: visible,
    };

    return ok(stringifyPayload(payload));
  });
}

/* ------------------------------------------------------------------ */
/* sample_rows                                                         */
/* ------------------------------------------------------------------ */

export interface SampleRowsArgs {
  schema?: string;
  table: string;
  /** Number of rows. Capped at min(50, cfg.maxRows). */
  limit?: number;
}

export async function sampleRows(args: SampleRowsArgs, cfg: DbConfig): Promise<ToolResult> {
  const schema = args.schema ?? "public";
  // `typeof` first, same reason as describeSchema: `IDENT_RE.test(x)` coerces
  // via String(x), so a non-string schema/table slips past the regex — and a
  // 1-element array like `["users"]` (-> "users") would actually query the
  // real table. Reject before coercion (#117/#119 sibling).
  if (typeof schema !== "string" || !IDENT_RE.test(schema)) {
    return err(`schema name must match ${IDENT_RE.source}; got ${JSON.stringify(schema)}`);
  }
  if (typeof args.table !== "string" || !IDENT_RE.test(args.table)) {
    return err(`table name must match ${IDENT_RE.source}; got ${JSON.stringify(args.table)}`);
  }
  const requested = args.limit ?? 10;
  if (!Number.isInteger(requested) || requested <= 0) {
    return err(`limit must be a positive integer; got ${JSON.stringify(requested)}`);
  }
  const limit = Math.min(requested, 50, cfg.maxRows);

  return withClient(cfg, async (c) => {
    return runSampleQuery(c, schema, args.table, limit);
  });
}

async function runSampleQuery(c: pg.Client, schema: string, table: string, limit: number): Promise<ToolResult> {
  // Identifiers are validated above and quoted explicitly. Don't use parameter
  // binding for identifiers — Postgres won't accept it and it'd hide the
  // strictness above.
  const sql = `SELECT * FROM "${schema}"."${table}" LIMIT ${limit}`;
  try {
    const result = await c.query({ text: sql, types: SELECT_TYPES });
    return ok(
      stringifyPayload({
        row_count: result.rows.length,
        fields: result.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) ?? [],
        rows: result.rows,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`sample_rows error: ${msg}`);
  }
}
