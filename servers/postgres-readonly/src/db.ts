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
  const maxRows = parseIntEnv("MAX_ROWS", 1000);
  const statementTimeoutMs = parseIntEnv("STATEMENT_TIMEOUT_MS", 5000);
  return { connectionString, maxRows, statementTimeoutMs };
}

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
  if (!Number.isInteger(cfg.statementTimeoutMs) || cfg.statementTimeoutMs < 1) {
    throw new Error(
      `DbConfig.statementTimeoutMs must be an integer >= 1; got ${cfg.statementTimeoutMs}. ` +
        `In Postgres semantics, statement_timeout = 0 means no timeout — the per-query timeout ` +
        `is security-relevant defense in depth and must not be silently disabled by a programmatic 0.`,
    );
  }
}

/**
 * Open a fresh client for one query. We intentionally don't pool. The MCP server
 * lives for the duration of one client conversation; per-call clients keep the
 * blast radius of any leaked state to one statement.
 */
export async function withClient<T>(
  cfg: DbConfig,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  // Programmatic-entry validation (#44): a misconstructed `DbConfig`
  // must fail loud before any connection or SQL is issued. Reasoning
  // and gap inventory live on `validateDbConfig` above.
  validateDbConfig(cfg);
  const client = new Client({ connectionString: cfg.connectionString });
  await client.connect();
  try {
    await client.query(`SET statement_timeout = ${cfg.statementTimeoutMs}`);
    // Belt & suspenders: this also rejects writes at the server-session level,
    // so even if the role is mis-configured the session can't write.
    await client.query("SET default_transaction_read_only = on");
    return await fn(client);
  } finally {
    await client.end();
  }
}
