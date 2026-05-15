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
 * Open a fresh client for one query. We intentionally don't pool. The MCP server
 * lives for the duration of one client conversation; per-call clients keep the
 * blast radius of any leaked state to one statement.
 */
export async function withClient<T>(
  cfg: DbConfig,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
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
