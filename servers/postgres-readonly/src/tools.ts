import type pg from "pg";
import { type DbConfig, withClient } from "./db.js";
import { guardQuery } from "./sqlGuard.js";

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

export async function describeSchema(args: DescribeSchemaArgs, cfg: DbConfig): Promise<ToolResult> {
  const schema = args.schema ?? "public";
  if (!IDENT_RE.test(schema)) {
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
      lines.push(`\n  ${t.table_type === "VIEW" ? "[view] " : ""}${t.table_name}`);
      for (const col of cols) {
        const nullable = col.is_nullable === "YES" ? "" : " NOT NULL";
        const dflt = col.column_default ? ` DEFAULT ${col.column_default}` : "";
        const type = formatColumnType(col.data_type, col.udt_name);
        lines.push(`    - ${col.column_name}: ${type}${nullable}${dflt}`);
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
      result = await c.query(args.sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`query execution error: ${msg}`);
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

    return ok(JSON.stringify(payload, null, 2));
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
  if (!IDENT_RE.test(schema)) {
    return err(`schema name must match ${IDENT_RE.source}; got ${JSON.stringify(schema)}`);
  }
  if (!IDENT_RE.test(args.table)) {
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
    const result = await c.query(sql);
    return ok(
      JSON.stringify(
        {
          row_count: result.rows.length,
          fields: result.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) ?? [],
          rows: result.rows,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`sample_rows error: ${msg}`);
  }
}
