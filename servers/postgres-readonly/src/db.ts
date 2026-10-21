import pg from "pg";
const { Client } = pg;

export interface DbConfig {
  connectionString: string;
  /** Hard cap on rows returned per query. Server truncates beyond this. */
  maxRows: number;
  /** Per-query timeout in ms. Server cancels queries exceeding this. */
  statementTimeoutMs: number;
}

export function readDbConfigFromEnv(): DbConfig {
  // Trim before gating, and gate on *content* rather than falsiness (#157).
  //
  // `if (!process.env.DATABASE_URL)` accepts a whitespace-only value, and
  // nothing trimmed a padded one — which is the shape a `.env` line or a YAML
  // block routinely produces. `pg` does not tolerate it: one leading space and
  // the string is no longer parsed as a URL at all, so keyword/value parsing
  // takes over. Measured on `new Client({ connectionString }).connectionParameters`
  // in a clean environment:
  //
  //   "postgres://u:p@h:5432/db"    -> host "h",    database "db",  user "u"
  //   " postgres://u:p@h:5432/db "  -> host "base", database " postgres://u:p@h:5432/db "
  //   "   "                         -> host "base", database "   "
  //   ""                            -> host "localhost"
  //
  // A different host, the whole connection string as the database name, and no
  // user — so it authenticates as the process's OS user. The message below
  // calls the read-only role "your defense-in-depth"; with a stray space the
  // role is not used at all. (The `""` row is the one `validateDbConfig`
  // already documents as worth guarding, and it is the *least* dangerous of the
  // four.)
  //
  // `parseIntEnv` below already trims, and says why: "a value read from a
  // `.env` line or a YAML block routinely carries whitespace". Same function,
  // same argument, and the string read was the one that skipped it.
  const connectionString = (process.env.DATABASE_URL ?? "").trim();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required. Use a connection string for a READ-ONLY role; this server enforces query-level read-only on top, but the role enforcement is your defense-in-depth.",
    );
  }
  const maxRows = boundMaxRows(parseIntEnv("MAX_ROWS", 1000));
  const statementTimeoutMs = parseIntEnv("STATEMENT_TIMEOUT_MS", 5000);
  // `parseIntEnv` bounds at MAX_SAFE_INTEGER, which is a *precision* bound.
  // The usable bound is far lower; see MAX_STATEMENT_TIMEOUT_MS (#277).
  if (statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS) {
    throw new Error(
      `env STATEMENT_TIMEOUT_MS must be <= ${MAX_STATEMENT_TIMEOUT_MS} (2**31 - 1 minus the 1s ` +
        `query backstop); above it Node's setTimeout fires after ~1ms and every query times out ` +
        `immediately; got ${statementTimeoutMs}`,
    );
  }
  return { connectionString, maxRows, statementTimeoutMs };
}

/**
 * Largest `statementTimeoutMs` any of its three consumers can honour (#277).
 *
 * `withClient` hands the value to two client-side timers (#229) --
 * `connectionTimeoutMillis: max(value, 5000)` and `query_timeout: value + 1000`
 * -- and Node clamps any `setTimeout` delay above `2**31 - 1` to 1 ms. Measured
 * on PostgreSQL 17.6: `2147482647` ran the query; `2147482648` (query backstop
 * = `2**31`) failed every call with "Query read timeout" in ~3 ms, and
 * `2147483648` failed every connect with "timeout expired". Postgres itself
 * refuses `SET statement_timeout` above `INT_MAX`, so nothing past this bound
 * works at all. It is the #143 bound github-gists and internal-tools-bridge
 * already enforce, less the backstop's extra second.
 */
export const MAX_STATEMENT_TIMEOUT_MS = 2 ** 31 - 1 - 1000;

/**
 * Parse a positive-integer environment variable, or return `fallback`.
 *
 * `Number.parseInt` stops at the first character it cannot consume and returns
 * what it has, so it accepts a far larger language than "a positive integer" —
 * and the old message claimed the value *was* one when it wasn't (#152):
 *
 * ```
 * "5s"        -> 5        "1e3"   -> 1     "10.9"  -> 10
 * "30m"       -> 30       "1e10"  -> 1     "1_000" -> 1
 * "1000ms"    -> 1000     "5 seconds" -> 5
 * "9007199254740993" -> 9007199254740992   (silently one lower)
 * ```
 *
 * The top rows are the dangerous ones because `STATEMENT_TIMEOUT_MS` is a
 * *duration*, and the natural way to write a duration is with a unit. An
 * operator writing `5s` means five seconds and gets **five milliseconds** — a
 * bound 1000x tighter than intended, with every query then failing and the
 * config file still reading `5s`. `1000ms` happening to be correct is worse
 * than the others, because it teaches that the suffix is understood.
 * `MAX_ROWS` is a security-relevant cap and takes `10.9` as `10`, `1_000` as 1.
 *
 * The grammar here is `filesystem-sandbox`'s, which #98/#137 already settled
 * and which survived a Python-parity review: trim, gate on an explicit
 * `^[+-]?\d+$`, bound the magnitude with `BigInt` *before* `Number` can lose
 * precision, then parse. Each server in this cookbook is a standalone,
 * copy-pasteable package, so the three parsers cannot share a module — they
 * share a grammar, enforced across servers by
 * `tools/check-numeric-env-grammar.mjs`.
 *
 * Whitespace is trimmed rather than rejected. #152 proposed
 * `String(n) !== raw`, which is exact and needs no grammar, but would refuse
 * `" 7 "` — and a value read from a `.env` line or a YAML block routinely
 * carries whitespace. Trimming first reopens none of the rows above (`" 5s"`
 * still throws), and it matches what `filesystem-sandbox` already does.
 */
function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const withinSafeRange =
    /^[+-]?\d+$/.test(trimmed) && BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER);
  const n = withinSafeRange ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `env ${name} must be a positive integer no greater than ${Number.MAX_SAFE_INTEGER} ` +
        `written in plain base-10 digits (no unit suffix, no scientific notation, no ` +
        `separators); got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Largest `MAX_ROWS` `run_select` can fetch with (#280).
 *
 * `parseIntEnv` bounds at MAX_SAFE_INTEGER, which is a *precision* bound.
 * Since #256 `run_select` sends `FETCH FORWARD <MAX_ROWS + 1>`, and Postgres
 * reads a FETCH count as a 32-bit integer. Measured on PostgreSQL 17.6:
 * `MAX_ROWS=2147483646` returned rows; `2147483647` booted and then failed
 * every `run_select` with `syntax error at or near "2147483648"` -- an error
 * that points the model at SQL it did not write.
 */
export const MAX_MAX_ROWS = 2 ** 31 - 1 - 1;

function boundMaxRows(maxRows: number): number {
  if (maxRows > MAX_MAX_ROWS) {
    throw new Error(
      `env MAX_ROWS must be <= ${MAX_MAX_ROWS} (2**31 - 1 minus the one extra row run_select ` +
        `fetches to detect truncation); above it Postgres refuses the cursor's FETCH count and ` +
        `every run_select fails; got ${maxRows}`,
    );
  }
  return maxRows;
}

/**
 * Validate a `DbConfig` at the programmatic entry of `withClient` so the
 * security-relevant numeric fields cannot be silently degenerate when a
 * caller (test, custom driver, future cross-server import per D-002's
 * "explicit cross-server import" carve-out) builds one directly rather
 * than through `readDbConfigFromEnv`.
 *
 * Without this guard:
 *   - `statementTimeoutMs = 0` is interpolated into `SET statement_timeout = 0`
 *     which in Postgres semantics means **no timeout** — silently
 *     disabling the security-relevant per-query timeout.
 *   - `maxRows = 0` produces empty result sets via `rows.slice(0, 0)`
 *     in tools.ts and `LIMIT 0` via `Math.min(requested, 50, 0)` in
 *     `sample_rows` — silent degeneracy on a documented row cap.
 *   - `connectionString = ""` constructs a `pg.Client` whose `.connect()`
 *     falls back on the libpq env defaults instead of honoring the
 *     documented contract.
 *
 * Mirrors the portfolio's contract-tightening sweep also applied to
 * this repo's `internal-tools-bridge` `BridgeConfig` (#4, D-009): the
 * silent-degeneracy shapes documented inline at bridge.ts L96-103 are
 * the same class of failure being closed here on a sibling `Config`.
 */
export function validateDbConfig(cfg: DbConfig): void {
  // `length === 0` was the falsiness check one layer down, and carried the same
  // gap (#157): a whitespace-only string has non-zero length and reaches
  // `new Client`, where `pg` resolves it to `host: "base"` with the string as
  // the database name — strictly worse than the `""` case this guard's own
  // comment above is written about. Gate on content.
  if (typeof cfg.connectionString !== "string" || cfg.connectionString.trim().length === 0) {
    throw new Error(
      `DbConfig.connectionString must be a non-empty string; got ${JSON.stringify(cfg.connectionString)}`,
    );
  }
  if (!Number.isInteger(cfg.maxRows) || cfg.maxRows < 1) {
    throw new Error(`DbConfig.maxRows must be an integer >= 1; got ${cfg.maxRows}`);
  }
  if (cfg.maxRows > MAX_MAX_ROWS) {
    throw new Error(
      `DbConfig.maxRows must be <= ${MAX_MAX_ROWS}; got ${cfg.maxRows}. run_select fetches ` +
        `maxRows + 1 rows, and Postgres reads a FETCH count as a 32-bit integer (#280).`,
    );
  }
  if (!Number.isInteger(cfg.statementTimeoutMs) || cfg.statementTimeoutMs < 1) {
    throw new Error(
      `DbConfig.statementTimeoutMs must be an integer >= 1; got ${cfg.statementTimeoutMs}. ` +
        `In Postgres semantics, statement_timeout = 0 means no timeout — the per-query timeout ` +
        `is security-relevant defense in depth and must not be silently disabled by a programmatic 0.`,
    );
  }
  if (cfg.statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS) {
    throw new Error(
      `DbConfig.statementTimeoutMs must be <= ${MAX_STATEMENT_TIMEOUT_MS}; got ${cfg.statementTimeoutMs}. ` +
        `Above it the client's connect and query timers overflow Node's setTimeout and fire after ~1ms, ` +
        `so every call fails as a timeout (#277).`,
    );
  }
}

/**
 * Open a fresh client for one query. We intentionally don't pool. The MCP server
 * lives for the duration of one client conversation; per-call clients keep the
 * blast radius of any leaked state to one statement.
 */
/** Lowest connect timeout `withClient` uses, whatever `statementTimeoutMs` is (#229). */
export const CONNECT_TIMEOUT_FLOOR_MS = 5_000;

export async function withClient<T>(
  cfg: DbConfig,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  // Programmatic-entry validation (#44): a misconstructed `DbConfig`
  // must fail loud before any connection or SQL is issued. Reasoning
  // and gap inventory live on `validateDbConfig` above.
  validateDbConfig(cfg);
  // Bounded on the client side too (#229). `statement_timeout` is a SERVER
  // setting, sent only once `connect()` has succeeded, and `pg` waits forever
  // for both the connection and each query by default: a host that accepted
  // TCP and never spoke Postgres hung the tool call before the advertised
  // bound could apply. The connect gets the operator's budget, but never less
  // than CONNECT_TIMEOUT_FLOOR_MS: connection setup (TCP, TLS, auth) costs the
  // same whatever the query budget, and a deliberately tight statement timeout
  // must not make connecting impossible. The client-side query backstop is a
  // second longer than the server's, so the server's cancellation (and its
  // clearer error) normally wins.
  const client = new Client({
    connectionString: cfg.connectionString,
    connectionTimeoutMillis: Math.max(cfg.statementTimeoutMs, CONNECT_TIMEOUT_FLOOR_MS),
    query_timeout: cfg.statementTimeoutMs + 1000,
  });
  await client.connect();
  try {
    await client.query(`SET statement_timeout = ${cfg.statementTimeoutMs}`);
    // Belt & suspenders: this also rejects writes at the server-session level,
    // so even if the role is mis-configured the session can't write.
    await client.query("SET default_transaction_read_only = on");
    // The guard lexes a plain '...' literal as standard SQL, where a backslash
    // is an ordinary character (#252). The server, database or role can turn
    // this off, and then `'\''` is a complete literal to Postgres while the
    // guard reads the last `'` as opening a new one: measured on Postgres 17
    // with the role set to off, `SELECT '\''; COMMIT; BEGIN READ WRITE; DROP
    // TABLE victim; COMMIT; --'` passed the guard and dropped the table. Pin
    // it so the server reads every literal the way the guard did. The query
    // cannot undo this: SET and set_config are forbidden, and every call gets
    // a fresh connection.
    await client.query("SET standard_conforming_strings = on");
    // The result parsers read the ISO DateStyle and the `postgres` IntervalStyle
    // only, and the same server, database or role can change both (#299).
    // Measured on Postgres 17 with the role set: under DateStyle 'SQL, DMY',
    // 'German' or 'Postgres, MDY' every timestamptz came back as null (which a
    // client reads as SQL NULL, the #207/#249 harm) and a date as the ambiguous
    // `04/03/2024`; under IntervalStyle 'iso_8601' every interval came back as
    // `{}`, the same value as a zero interval. Pin the formats the parsers read.
    await client.query("SET DateStyle = ISO");
    await client.query("SET IntervalStyle = postgres");
    // `bytea` is returned as the database's text (#315), and `bytea_output` is
    // inherited the same way: under 'escape' `\x0102` printed as `\001\002`.
    // Pin the hex form the payload documents.
    await client.query("SET bytea_output = hex");
    return await fn(client);
  } finally {
    await client.end();
  }
}
