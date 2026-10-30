import pg from "pg";
const { Client } = pg;

export interface DbConfig {
  connectionString: string;
  /** Hard cap on rows returned per query. Server truncates beyond this. */
  maxRows: number;
  /** Per-query timeout in ms. Server cancels queries exceeding this. */
  statementTimeoutMs: number;
  /**
   * Cap on the bytes of row text one `run_select`, `sample_rows` or
   * `describe_schema` reads (#347, #366), and on the bytes of the listing
   * `describe_schema` writes. Optional so a `DbConfig` built before it existed keeps working;
   * absent means DEFAULT_MAX_RESULT_BYTES.
   */
  maxResultBytes?: number;
}

/** `MAX_RESULT_BYTES` when unset (#347): 16 MiB of row text. */
export const DEFAULT_MAX_RESULT_BYTES = 16 * 1024 * 1024;

/**
 * Largest `MAX_RESULT_BYTES` that still prevents the crash it exists for
 * (#347): V8's maximum string length, 0x1fffffe8. One value longer than this
 * threw ERR_STRING_TOO_LONG inside pg-protocol's socket handler, where nothing
 * catches it, and the process exited.
 */
export const MAX_MAX_RESULT_BYTES = 0x1fffffe8;

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
  const maxResultBytes = parseIntEnv("MAX_RESULT_BYTES", DEFAULT_MAX_RESULT_BYTES);
  if (maxResultBytes > MAX_MAX_RESULT_BYTES) {
    throw new Error(
      `env MAX_RESULT_BYTES must be <= ${MAX_MAX_RESULT_BYTES} (V8's maximum string length); ` +
        `above it one value can crash the server before the cap applies; got ${maxResultBytes}`,
    );
  }
  return { connectionString, maxRows, statementTimeoutMs, maxResultBytes };
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
  if (
    cfg.maxResultBytes !== undefined &&
    (!Number.isInteger(cfg.maxResultBytes) || cfg.maxResultBytes < 1 || cfg.maxResultBytes > MAX_MAX_RESULT_BYTES)
  ) {
    throw new Error(
      `DbConfig.maxResultBytes must be an integer from 1 to ${MAX_MAX_RESULT_BYTES}; got ${cfg.maxResultBytes} (#347)`,
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
  // A destroyed socket (the byte guard below, or a database that drops the
  // connection) makes pg emit `error` on the client as well as rejecting the
  // active query. With no listener that emit throws and the process exits; the
  // query's rejection already carries the error to the caller.
  client.on("error", () => {});
  await client.connect();
  try {
    // Installed before the first SET so that every reply this session reads
    // is bounded (#350). See ResponseByteGuard.
    responseGuards.set(client, guardResponses(client, cfg.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES));
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
    // float4/float8 (and float4[]/float8[], #303, and the geometric types) are
    // parsed from the text the server prints, and `extra_float_digits` is
    // inherited the same way (#324). Measured on Postgres 17.6 with the role
    // at -15: 1234.5678 came back as the plain number `1000` and
    // point(1.23456,9.87654) as {x:1,y:10}; at 0, the pre-PG12 default,
    // 0.1+0.2 came back as 0.3. 3, not 1: on PG12+ any positive value prints
    // the shortest exact form, identical to the default; before 12, 3 is the
    // value that round-trips a double.
    await client.query("SET extra_float_digits = 3");
    return await fn(client);
  } finally {
    await client.end();
  }
}

/* ------------------------------------------------------------------ */
/* wire byte guard (#350)                                              */
/* ------------------------------------------------------------------ */

/**
 * Wire bytes allowed on one message beyond `MAX_RESULT_BYTES`. A DataRow
 * frames its values with 6 bytes plus 4 per column (at most 1664 columns, plus
 * the #347 running-total column and its digits), so the largest row #347's
 * wrapper lets through is under 7 KiB longer on the wire than its record text.
 */
export const MESSAGE_FRAMING_ALLOWANCE = 64 * 1024;

/** A reply refused by the byte guard; its message is the tool's error text. */
export class ResultTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultTooLargeError";
  }
}

const MESSAGE_KINDS: Record<string, string> = { D: "row", E: "error message", N: "notice" };

/**
 * Counts the bytes of the database's replies from their message headers, and
 * says when one goes past a bound (#350).
 *
 * #347 bounds `run_select` and `sample_rows` inside Postgres, by running the
 * query as a byte-capped subquery. Two replies are not rows of such a
 * subquery, and each could still carry one value longer than V8 allows into
 * pg-protocol's socket handler, where ERR_STRING_TOO_LONG is thrown with no
 * catch above it and the process exits. Measured on PostgreSQL 18.0:
 *
 * - `EXPLAIN VERBOSE SELECT repeat('x', 600000000)`. EXPLAIN cannot be a
 *   subquery, and the planner folds the constant into the plan text;
 * - `SELECT repeat('x', 600000000)::int`, wrapped, whose ErrorResponse quotes
 *   the whole value (1670 MB peak, then the same exit).
 *
 * A Postgres message starts with a type byte and a 4-byte length (which counts
 * itself), so its size is known before its body arrives. Every message longer
 * than `messageLimit` is refused at its header. Rows of a response armed with
 * `limitResponse` (EXPLAIN, which nothing else bounds) are refused once their
 * total passes that limit, also at the header of the row that would cross it.
 * Wrapped queries get no total here: #347 enforces theirs in Postgres, and the
 * wire framing of many narrow rows is several times their record text, so a
 * wire total would refuse results #347 allows.
 */
export class ResponseByteGuard {
  private readonly header = Buffer.alloc(5);
  private headerFill = 0;
  /** Body bytes of the current message not yet seen. */
  private remaining = 0;
  private responseLimit: number | undefined;
  private responseBytes = 0;
  /** Why the stream was refused, once it has been. */
  refused: string | undefined;

  constructor(readonly messageLimit: number) {}

  /** Bound the row bytes of the next reply to `bytes` (until `endResponse`). */
  limitResponse(bytes: number): void {
    this.responseLimit = bytes;
    this.responseBytes = 0;
  }

  endResponse(): void {
    this.responseLimit = undefined;
  }

  /** Read one chunk of the stream; the reason to refuse it, or undefined. */
  feed(chunk: Buffer): string | undefined {
    let i = 0;
    while (i < chunk.length) {
      if (this.remaining > 0) {
        const skip = Math.min(this.remaining, chunk.length - i);
        this.remaining -= skip;
        i += skip;
        continue;
      }
      const take = Math.min(5 - this.headerFill, chunk.length - i);
      chunk.copy(this.header, this.headerFill, i, i + take);
      this.headerFill += take;
      i += take;
      if (this.headerFill < 5) break;
      this.headerFill = 0;
      const type = String.fromCharCode(this.header[0]!);
      const length = this.header.readUInt32BE(1);
      const kind = MESSAGE_KINDS[type] ?? `'${type}' message`;
      if (length > this.messageLimit) {
        return (
          `result too large: the database sent a ${length}-byte ${kind}, over the ${this.messageLimit}-byte ` +
          `limit for one message (MAX_RESULT_BYTES plus framing, #350); select fewer columns or shorten ` +
          `large values (e.g. left(col, 1000))`
        );
      }
      if (type === "D" && this.responseLimit !== undefined) {
        this.responseBytes += length - 4;
        if (this.responseBytes > this.responseLimit) {
          return (
            `result too large: the rows read so far total more than ${this.responseLimit} bytes on the wire, ` +
            `over the MAX_RESULT_BYTES cap (#350); EXPLAIN output is bounded as it arrives, since it cannot ` +
            `run as a subquery`
          );
        }
      }
      this.remaining = Math.max(0, length - 4);
    }
    return undefined;
  }
}

const responseGuards = new WeakMap<object, ResponseByteGuard | undefined>();

/** The byte guard `withClient` installed on `client`, if it has a socket (test doubles do not). */
export function responseGuardOf(client: object): ResponseByteGuard | undefined {
  return responseGuards.get(client);
}

/** The largest single message `withClient` reads for a given MAX_RESULT_BYTES. */
export function messageLimitFor(maxResultBytes: number): number {
  // Never above V8's string limit: one value that long is the crash itself.
  return Math.min(maxResultBytes + MESSAGE_FRAMING_ALLOWANCE, MAX_MAX_RESULT_BYTES);
}

function guardResponses(client: pg.Client, maxResultBytes: number): ResponseByteGuard | undefined {
  // `connection.stream` is the stream pg-protocol parses: after TLS is set up
  // it is the decrypted one, so headers can be read from it.
  const stream = (client as { connection?: { stream?: NodeJS.ReadableStream & { destroy(e?: Error): void } } })
    .connection?.stream;
  if (!stream || typeof stream.prependListener !== "function") return undefined;
  const guard = new ResponseByteGuard(messageLimitFor(maxResultBytes));
  // Prepended, so the guard reads each chunk before the parser does. The
  // parser still gets the chunk that carried the refused header. A message
  // over `messageLimit` is longer than any socket read (64 KiB), so the parser
  // only buffers its start. The rows of a response over its total can arrive
  // whole in that chunk, and the query then resolves: callers that limit a
  // response check `refused` after it.
  stream.prependListener("data", (chunk: Buffer) => {
    if (guard.refused !== undefined) return;
    const reason = guard.feed(chunk);
    if (reason !== undefined) {
      guard.refused = reason;
      stream.destroy(new ResultTooLargeError(reason));
    }
  });
  return guard;
}
