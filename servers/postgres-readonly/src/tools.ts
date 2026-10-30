import { randomUUID } from "node:crypto";
import pg from "pg";
import { DEFAULT_MAX_RESULT_BYTES, type DbConfig, ResultTooLargeError, responseGuardOf, withClient } from "./db.js";
import { guardQuery, leadingKeyword, subqueryBody } from "./sqlGuard.js";
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

// `interval` and its array (#301). PostgreSQL 17 added `infinity` and
// `-infinity` intervals, and pg's interval parser yields an empty object for
// any text it does not match: both came back as `{}`, the same JSON as a zero
// interval. Name them, as `nonFiniteAsString` names a float's Infinity; every
// finite interval keeps pg's object.
const INTERVAL_OID = 1186;
const INTERVAL_ARRAY_OID = 1187;
const INFINITE_INTERVALS = new Set(["infinity", "-infinity"]);

function intervalParser(format: string): (value: string) => unknown {
  const parseFinite = pgParser(INTERVAL_OID, format);
  return (value: string) => (INFINITE_INTERVALS.has(value) ? value : parseFinite(value));
}

function mapIntervalElements(value: unknown, parse: (v: string) => unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => mapIntervalElements(v, parse));
  return typeof value === "string" ? parse(value) : value;
}

// `numeric[]` (#303). Scalar `numeric` has no pg parser, so it already reaches
// the payload as the database's text (the #247 note above relies on that), but
// pg parses its array with `parseFloat`: `12345678901234567891` came back as
// `12345678901234567000`, `1.10` as `1.1` and `1e400` as `"Infinity"`. Its
// elements are kept as the database's strings, like the scalar.
const NUMERIC_ARRAY_OID = 1231;

// `bytea` and `bytea[]` (#315). pg parses bytea into a Node `Buffer`, which
// JSON writes as `{"type":"Buffer","data":[1,2]}`: the same JSON as a `json`
// value of that shape, so a client could not tell the two apart, and about
// 15 characters per byte against 2 for the database's hex text (a 100,000-byte
// value was a 1,500,237-character payload, its `::text` 200,180). Keep the
// database's text, `\x0102`, which `withClient` pins to hex; the array's
// elements are kept as the database's strings, as `numeric[]` does.
const BYTEA_OID = 17;
const BYTEA_ARRAY_OID = 1001;

export const SELECT_TYPES = {
  getTypeParser(oid: number, format?: string): (value: string) => unknown {
    if (DATE_OIDS.has(oid)) return (value: string) => value;
    if (DATE_ARRAY_OIDS.has(oid)) return pgParser(TEXT_ARRAY_OID, format ?? "text");
    if (oid === NUMERIC_ARRAY_OID) return pgParser(TEXT_ARRAY_OID, format ?? "text");
    if (oid === BYTEA_OID) return (value: string) => value;
    if (oid === BYTEA_ARRAY_OID) return pgParser(TEXT_ARRAY_OID, format ?? "text");
    if (JSON_OIDS.has(oid)) return (value: string) => new RawJson(value);
    if (JSON_ARRAY_OIDS.has(oid)) {
      const parseTextArray = pgParser(TEXT_ARRAY_OID, format ?? "text");
      return (value: string) => rawJsonElements(parseTextArray(value));
    }
    if (oid === INTERVAL_OID) return intervalParser(format ?? "text");
    if (oid === INTERVAL_ARRAY_OID) {
      const parseTextArray = pgParser(TEXT_ARRAY_OID, format ?? "text");
      const parseElement = intervalParser(format ?? "text");
      return (value: string) => mapIntervalElements(parseTextArray(value), parseElement);
    }
    return pgParser(oid, format ?? "text");
  },
};

// Arrays of every other element type (#308). pg-types registers array parsers
// for a fixed list of element types -- 28 of PostgreSQL 17's 296 array types --
// so `name[]` (`current_schemas(true)`), range arrays, `"char"[]`, `bit[]` and
// every enum array came back as ONE string in array-literal form: an enum array
// `{happy,sad}` was indistinguishable from the text value '{happy,sad}'. A
// RowDescription carries only the oid, and an enum array's oid is per-database,
// so array-ness is read from the catalog: an array type is some type's
// `typarray`. (`int2vector`/`oidvector` are typcategory 'A' too, but print
// space-separated and are nobody's `typarray`.) Elements are kept as the
// database's strings, as `text[]` does. Only a column with no pg parser and a
// value that can be an array literal -- array output starts with `{`, or `[`
// for a non-default lower bound -- is looked up, so a result of plain text and
// numbers costs no extra round trip.
// The parser splits on a comma, but each type names its own delimiter in
// `typdelim`: `box` uses `;`, so `{(1,1),(0,0);(3,3),(2,2)}` was split on the
// commas inside each box into fragments (#311). An array whose element type
// has any other delimiter keeps the database's text, as before #308.
const getPgTypeParser = pg.types.getTypeParser as (oid: number, format?: string) => (value: string) => unknown;
// pg-types' identity fallback; oid 0 is InvalidOid, never a type.
const NO_PARSER = getPgTypeParser(0, "text");
const ARRAY_LITERAL_START = /^[{[]/;
const ARRAY_OIDS_SQL =
  "SELECT t.oid, e.typdelim FROM pg_catalog.pg_type t " +
  "JOIN pg_catalog.pg_type e ON e.typarray = t.oid WHERE t.oid = ANY($1::oid[])";

/** Parse, in place, each column of an unregistered array type as a text array (#308). */
export async function parseUnregisteredArrays(
  c: Pick<pg.Client, "query">,
  fields: ReadonlyArray<{ dataTypeID: number }> | undefined,
  rows: unknown[][],
): Promise<void> {
  const candidates = new Set<number>();
  (fields ?? []).forEach((f, i) => {
    if (SELECT_TYPES.getTypeParser(f.dataTypeID) !== NO_PARSER) return;
    if (rows.some((r) => typeof r[i] === "string" && ARRAY_LITERAL_START.test(r[i]))) {
      candidates.add(f.dataTypeID);
    }
  });
  if (candidates.size === 0) return;
  const found = await c.query<{ oid: number; typdelim: string }>({ text: ARRAY_OIDS_SQL, values: [[...candidates]] });
  const arrayOids = new Set(found.rows.filter((r) => r.typdelim === ",").map((r) => Number(r.oid)));
  if (arrayOids.size === 0) return;
  const parseTextArray = pgParser(TEXT_ARRAY_OID, "text");
  (fields ?? []).forEach((f, i) => {
    if (!arrayOids.has(f.dataTypeID)) return;
    for (const r of rows) if (typeof r[i] === "string") r[i] = parseTextArray(r[i]);
  });
}

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

/**
 * The rows of an `rowMode: "array"` result as objects keyed by field name, every
 * name an own property (#293).
 *
 * pg's object rows assign `row[name] = value`, and for a column named
 * `__proto__` that assignment SETS THE ROW'S PROTOTYPE instead of adding a key.
 * A scalar value was dropped while `fields` still listed it; a `json`/`jsonb`
 * value made the row's prototype a `RawJson`, so `stringifyPayload` took the
 * row itself for that column and replaced the whole row with the column's JSON
 * text. `Object.fromEntries` defines properties rather than assigning them.
 * Callers refuse duplicate names first, so no entry overwrites another.
 */
export function rowsByName(
  fields: ReadonlyArray<{ name: string }> | undefined,
  rows: ReadonlyArray<unknown> | undefined,
): Array<Record<string, unknown>> {
  const names = (fields ?? []).map((f) => f.name);
  return (rows ?? []).map((row) =>
    Object.fromEntries(names.map((name, i) => [name, (row as unknown[])[i]])),
  );
}

/* ------------------------------------------------------------------ */
/* result byte cap (#347)                                              */
/* ------------------------------------------------------------------ */

/**
 * One query's byte bound: `sql` wraps the query so Postgres itself stops at
 * the first row that takes the result past `cap` bytes of row text (#347).
 *
 * MAX_ROWS bounded rows, not bytes, and a single value is enough to kill the
 * process: `SELECT repeat('x', 600000000)` threw ERR_STRING_TOO_LONG inside
 * pg-protocol's socket handler, where no catch reaches, and the server exited
 * (measured on PostgreSQL 17.6; 4e8 characters returned after a 1.6 GB peak).
 * Nothing in this process can refuse a value it has already been sent, so the
 * check runs in the database, before the row is sent:
 *
 * - each row is measured as `octet_length((s.*)::text)`, its record text. That
 *   is at least the bytes its columns put on the wire (it adds quotes,
 *   escapes and separators). It is `(s.*)`, not bare `s`: a bare name
 *   resolves to a COLUMN `s` before the whole row, and a query with a column
 *   called `s` then measured that column alone (4 bytes for a 57-byte row);
 * - a window keeps the running total, which streams: a FETCH of 11 rows from a
 *   3M-row table took 0.09 ms wrapped and 0.13 ms bare;
 * - once the total passes `cap`, a cast of a text that holds a per-call nonce
 *   fails, which aborts the FETCH before that row leaves the server. A WHERE
 *   that skipped the row instead would go on scanning for rows that can never
 *   pass, until the statement timeout.
 *
 * The total travels as one extra trailing column, named with the same nonce so
 * no column of the query can take its name. `withoutByteColumn` removes it, and
 * `byteCapError` turns the cast's error back into a message naming the cap.
 */
export interface ByteCap {
  sql: string;
  nonce: string;
  column: string;
  cap: number;
}

export function byteCappedQuery(body: string, cap: number, nonce: string = randomUUID().replace(/-/g, "")): ByteCap {
  const column = `mcp_bytes_${nonce}`;
  // The body ends on its own line: a trailing `--` comment would otherwise run
  // over the closing parenthesis.
  const sql =
    `SELECT * FROM (SELECT s.*, sum(octet_length((s.*)::text)) ` +
    `OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ${column} FROM (\n${body}\n) s) w ` +
    `WHERE CASE WHEN w.${column} > ${cap} THEN ('${nonce}:' || w.${column})::int = 0 ELSE true END`;
  return { sql, nonce, column, cap };
}

/**
 * The result without the byte cap's running-total column. Postgres always
 * returns it last; it is matched by its nonce name, so a column of the query
 * can never be mistaken for it.
 */
export function withoutByteColumn<R extends { fields?: Array<{ name: string }>; rows?: unknown }>(
  result: R,
  cap: ByteCap,
): R {
  const fields = result.fields ?? [];
  if (fields.length === 0 || fields[fields.length - 1]!.name !== cap.column) return result;
  const rows = Array.isArray(result.rows) ? (result.rows as unknown[][]).map((r) => r.slice(0, -1)) : result.rows;
  return { ...result, fields: fields.slice(0, -1), rows };
}

/** The tool's message for an error the byte cap raised, or undefined for any other error. */
export function byteCapError(message: string, cap: ByteCap, setting: string): string | undefined {
  const m = message.match(new RegExp(`${cap.nonce}:(\\d+)`));
  if (!m) return undefined;
  return (
    `result too large: the rows read so far total ${m[1]} bytes as text, over the ${setting} cap of ` +
    `${cap.cap} bytes (#347); select fewer rows or columns, or shorten large values (e.g. left(col, 1000))`
  );
}

export async function runSelect(args: RunSelectArgs, cfg: DbConfig): Promise<ToolResult> {
  const guard = guardQuery(args.sql);
  if (!guard.ok) {
    return err(`query rejected by guard: ${guard.reason}`);
  }

  // Checked before connecting, like the guard: a query the wrapper cannot
  // hold is refused rather than embedded (#347). EXPLAIN is read directly.
  const explain = leadingKeyword(args.sql) === "EXPLAIN";
  const body = explain ? null : subqueryBody(args.sql);
  if (!explain && body === null) {
    return err(
      "query rejected: unbalanced parentheses or an unterminated comment or literal; " +
        "run_select runs the query as a subquery to bound its size (#347)",
    );
  }

  return withClient(cfg, async (c) => {
    let result;
    let cap: ByteCap | undefined;
    try {
      // Append LIMIT cfg.maxRows + 1 if the query has no LIMIT? No — that's a
      // quietly-modify-the-query semantic the operator probably doesn't want.
      // Nor fetch everything and truncate afterwards, as this did until #256:
      // the WHOLE result was materialised in this process first, so MAX_ROWS
      // bounded what the client saw and nothing else. Measured with
      // maxRows=10, `SELECT g, repeat('x',1000) FROM generate_series(1,400000)`
      // took the server from 90 MB to a 613 MB peak, and a wider one to 2.8 GB.
      // The query runs unchanged as the body of a cursor, and only
      // maxRows + 1 rows are fetched -- the extra one is how `truncated` is
      // known. EXPLAIN cannot be a cursor body; its output is a plan, not data.
      // The DB-side statement_timeout (set in withClient) bounds runtime.
      if (explain) {
        // ...so its plan rows are bounded on the wire instead (#350): the
        // planner folds constants into the plan text, and one plan line held a
        // 600M-character value that crashed the process.
        const guard = responseGuardOf(c);
        guard?.limitResponse(cfg.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES);
        try {
          result = await c.query({ text: args.sql, types: SELECT_TYPES, rowMode: "array" });
        } finally {
          guard?.endResponse();
        }
        if (guard?.refused !== undefined) return err(guard.refused);
      } else {
        // The query is the inner subquery of a byte-capped wrapper (#347), so
        // MAX_RESULT_BYTES is enforced in Postgres as rows are produced.
        cap = byteCappedQuery(body!, cfg.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES);
        await c.query("BEGIN");
        await c.query(`DECLARE mcp_run_select NO SCROLL CURSOR FOR ${cap.sql}`);
        const fetched = await c.query({
          text: `FETCH FORWARD ${cfg.maxRows + 1} FROM mcp_run_select`,
          types: SELECT_TYPES,
          rowMode: "array",
        });
        await c.query("COMMIT");
        result = withoutByteColumn(fetched, cap);
      }
      await parseUnregisteredArrays(c, result.fields, Array.isArray(result.rows) ? result.rows : []);
    } catch (e) {
      if (e instanceof ResultTooLargeError) return err(e.message);
      const msg = e instanceof Error ? e.message : String(e);
      const tooLarge = cap && byteCapError(msg, cap, "MAX_RESULT_BYTES");
      return err(tooLarge || `query execution error: ${msg}`);
    }

    const dups = duplicateColumnNames(result.fields);
    if (dups.length > 0) {
      return err(
        `query returns more than one column named ${dups.map((d) => JSON.stringify(d)).join(", ")}; ` +
          `rows are keyed by column name, so all but one value would be lost -- alias them ` +
          `(e.g. SELECT u.id AS user_id, o.id AS order_id ...)`,
      );
    }
    const rows = rowsByName(result.fields, Array.isArray(result.rows) ? result.rows : []);
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

  // Identifiers are validated above and quoted explicitly. Don't use parameter
  // binding for identifiers — Postgres won't accept it and it'd hide the
  // strictness above.
  const sql = `SELECT * FROM "${schema}"."${args.table}" LIMIT ${limit}`;
  // The same guard as run_select, on the SQL this tool builds (#363). Until
  // #363 it never ran here, so the relations the deny list refuses by name --
  // `pg_hba_file_rules`, `pg_ident_file_mappings` and `pg_file_settings`
  // (#258), which return pg_hba.conf, pg_ident.conf and postgresql.conf --
  // came back from `sample_rows {schema: "pg_catalog"}`. The guard leaves
  // double-quoted identifiers visible to its keyword scan, so the quoting
  // above does not hide a name from it.
  const guard = guardQuery(sql);
  if (!guard.ok) {
    return err(`query rejected by guard: ${guard.reason}`);
  }

  return withClient(cfg, async (c) => {
    return runSampleQuery(c, sql, cfg.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES);
  });
}

async function runSampleQuery(c: pg.Client, sql: string, maxResultBytes: number): Promise<ToolResult> {
  // Same bound as run_select (#347): 50 rows of a wide table are as able to
  // exhaust the process as one huge value.
  const cap = byteCappedQuery(sql, maxResultBytes);
  try {
    const result = withoutByteColumn(
      await c.query({ text: cap.sql, types: SELECT_TYPES, rowMode: "array" }),
      cap,
    );
    await parseUnregisteredArrays(c, result.fields, result.rows);
    return ok(
      stringifyPayload({
        row_count: result.rows.length,
        fields: result.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) ?? [],
        rows: rowsByName(result.fields, result.rows),
      }),
    );
  } catch (e) {
    if (e instanceof ResultTooLargeError) return err(e.message);
    const msg = e instanceof Error ? e.message : String(e);
    return err(byteCapError(msg, cap, "MAX_RESULT_BYTES") ?? `sample_rows error: ${msg}`);
  }
}
