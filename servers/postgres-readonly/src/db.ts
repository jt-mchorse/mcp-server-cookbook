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
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required. Use a connection string for a READ-ONLY role; this server enforces query-level read-only on top, but the role enforcement is your defense-in-depth.",
    );
  }
  const maxRows = parseIntEnv("MAX_ROWS", 1000);
  const statementTimeoutMs = parseIntEnv("STATEMENT_TIMEOUT_MS", 5000);
  return { connectionString, maxRows, statementTimeoutMs };
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`env ${name} must be a positive integer; got ${JSON.stringify(raw)}`);
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
  if (typeof cfg.connectionString !== "string" || cfg.connectionString.length === 0) {
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
