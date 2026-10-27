/**
 * Replies the #347 wrapper cannot bound are bounded on the wire (#350).
 *
 * #347 runs `run_select` and `sample_rows` as a byte-capped subquery, so
 * Postgres stops at the first row past MAX_RESULT_BYTES. Two replies are not
 * rows of that subquery. Measured on PostgreSQL 18.0 through `runSelect`:
 *
 *   EXPLAIN VERBOSE SELECT repeat('x', 600000000) AS w
 *     -> ERR_STRING_TOO_LONG in pg-protocol's parseDataRowMessage, exit 1
 *        (the planner folds the constant into the plan text)
 *   SELECT repeat('x', 600000000)::int AS w
 *     -> 1670 MB peak, then the same exit (the ErrorResponse quotes the value)
 *
 * `withClient` now reads every reply's message headers before pg-protocol
 * does, and destroys the socket at the header of a message longer than
 * MAX_RESULT_BYTES plus framing, or of the EXPLAIN row that takes the plan
 * past MAX_RESULT_BYTES.
 *
 * Hermetic: the end-to-end arms run the real `pg.Client` against a loopback
 * listener that speaks just enough of the Postgres protocol. No database.
 */
import net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_MAX_RESULT_BYTES,
  MESSAGE_FRAMING_ALLOWANCE,
  ResponseByteGuard,
  messageLimitFor,
} from "../src/db.js";
import { runSelect, sampleRows } from "../src/tools.js";

/* ------------------------------------------------------------------ */
/* protocol messages                                                   */
/* ------------------------------------------------------------------ */

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function cstring(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf8");
}

function rowDescription(fields: Array<{ name: string; oid: number }>): Buffer {
  const parts = [Buffer.from([fields.length >> 8, fields.length & 0xff])];
  for (const f of fields) {
    const meta = Buffer.alloc(18);
    meta.writeUInt32BE(0, 0); // table oid
    meta.writeInt16BE(0, 4); // attnum
    meta.writeUInt32BE(f.oid, 6);
    meta.writeInt16BE(-1, 10); // typlen
    meta.writeInt32BE(-1, 12); // typmod
    meta.writeInt16BE(0, 16); // text format
    parts.push(cstring(f.name), meta);
  }
  return message("T", Buffer.concat(parts));
}

function dataRow(values: string[]): Buffer {
  const parts = [Buffer.from([values.length >> 8, values.length & 0xff])];
  for (const v of values) {
    const bytes = Buffer.from(v, "utf8");
    const len = Buffer.alloc(4);
    len.writeInt32BE(bytes.length, 0);
    parts.push(len, bytes);
  }
  return message("D", Buffer.concat(parts));
}

function errorResponse(text: string): Buffer {
  return message(
    "E",
    Buffer.concat([Buffer.from("S"), cstring("ERROR"), Buffer.from("C"), cstring("22P02"), Buffer.from("M"), cstring(text), Buffer.from([0])]),
  );
}

const complete = (tag: string) => message("C", cstring(tag));
const ready = () => message("Z", Buffer.from("I"));

/* ------------------------------------------------------------------ */
/* a loopback "database"                                               */
/* ------------------------------------------------------------------ */

const sockets: net.Socket[] = [];
let listener: net.Server | undefined;

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await new Promise<void>((done) => (listener ? listener.close(() => done()) : done()));
  listener = undefined;
});

/**
 * Answers the startup message with AuthenticationOk, every SET/BEGIN/COMMIT/
 * DECLARE with its command tag, and every other simple query with
 * `answer(text, declared)` (the last DECLARE's text, for a FETCH).
 */
async function fakeDatabase(answer: (sql: string, declared: string | undefined) => Buffer[]): Promise<string> {
  listener = net.createServer((s) => {
    sockets.push(s);
    s.on("error", () => {});
    let buf = Buffer.alloc(0);
    let started = false;
    let declared: string | undefined;
    s.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 4 || buf.length < buf.readUInt32BE(0)) return;
          buf = buf.subarray(buf.readUInt32BE(0));
          started = true;
          s.write(Buffer.concat([message("R", Buffer.from([0, 0, 0, 0])), ready()]));
          continue;
        }
        if (buf.length < 5 || buf.length < 1 + buf.readUInt32BE(1)) return;
        const type = String.fromCharCode(buf[0]!);
        const body = buf.subarray(5, 1 + buf.readUInt32BE(1));
        buf = buf.subarray(1 + buf.readUInt32BE(1));
        if (type === "X") return void s.end();
        if (type !== "Q") continue;
        const sql = body.toString("utf8").replace(/\0$/, "");
        const tag = /^(SET|BEGIN|COMMIT|DECLARE)\b/.exec(sql)?.[1];
        if (tag === "DECLARE") declared = sql;
        const out = tag ? [complete(tag === "DECLARE" ? "DECLARE CURSOR" : tag)] : answer(sql, declared);
        if (!s.destroyed) s.write(Buffer.concat([...out, ready()]));
      }
    });
  });
  await new Promise<void>((done) => listener!.listen(0, "127.0.0.1", () => done()));
  return `postgresql://u:p@127.0.0.1:${(listener!.address() as AddressInfo).port}/x`;
}

const CAP = 1024;

async function cfgFor(answer: (sql: string, declared: string | undefined) => Buffer[], maxRows = 10) {
  return { connectionString: await fakeDatabase(answer), maxRows, statementTimeoutMs: 3000, maxResultBytes: CAP };
}

function planRows(lines: string[]): Buffer[] {
  return [rowDescription([{ name: "QUERY PLAN", oid: 25 }]), ...lines.map((l) => dataRow([l])), complete("EXPLAIN")];
}

function text(r: { content: Array<{ text: string }> }): string {
  return r.content[0]!.text;
}

/** The #347 wrapper's running-total column, read from the DECLARE the tool sent. */
function byteColumn(declared: string | undefined): string {
  const m = declared?.match(/AS (mcp_bytes_[0-9a-f]+) FROM \(/) ?? null;
  if (!m) throw new Error(`no byte-capped wrapper in ${declared}`);
  return m[1]!;
}

/* ------------------------------------------------------------------ */
/* the header reader                                                   */
/* ------------------------------------------------------------------ */

describe("ResponseByteGuard reads message headers (#350)", () => {
  it("refuses a message at its 5-byte header, before any of its body arrives", () => {
    const g = new ResponseByteGuard(100);
    const header = dataRow(["x".repeat(200)]).subarray(0, 5);
    expect(g.feed(header)).toMatch(/^result too large: the database sent a 210-byte row, over the 100-byte limit/);
  });

  it("reads a header split across chunks, one byte at a time", () => {
    const g = new ResponseByteGuard(100);
    const header = errorResponse("x".repeat(200)).subarray(0, 5);
    const verdicts = [...header].map((b) => g.feed(Buffer.from([b])));
    expect(verdicts.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
    expect(verdicts[4]).toMatch(/byte error message, over the 100-byte limit/);
  });

  it("skips every body byte, so a body that looks like a huge header is never read as one", () => {
    const g = new ResponseByteGuard(100);
    // The body of this row is "D\xff\xff\xff\xff...": a header claiming 4 GiB.
    const decoy = dataRow(["Dÿÿÿÿ".padEnd(40, "z")]);
    const stream = Buffer.concat([decoy, decoy, complete("SELECT 2"), ready()]);
    for (let i = 0; i < stream.length; i += 7) expect(g.feed(stream.subarray(i, i + 7))).toBeUndefined();
    expect(g.feed(dataRow(["x".repeat(200)]))).toMatch(/210-byte row/);
  });

  it("names notices and other message types by kind", () => {
    expect(new ResponseByteGuard(10).feed(message("N", Buffer.alloc(50)))).toMatch(/54-byte notice/);
    expect(new ResponseByteGuard(10).feed(message("T", Buffer.alloc(50)))).toMatch(/54-byte 'T' message/);
  });

  it("totals rows only while a response is limited, and only rows", () => {
    const g = new ResponseByteGuard(1000);
    const row = dataRow(["x".repeat(90)]); // 100 bytes after the length field
    for (let i = 0; i < 5; i++) expect(g.feed(row)).toBeUndefined(); // not limited
    g.limitResponse(250);
    expect(g.feed(Buffer.concat([rowDescription([{ name: "QUERY PLAN", oid: 25 }]), row, row]))).toBeUndefined();
    expect(g.feed(row)).toMatch(/rows read so far total more than 250 bytes on the wire/);
    g.endResponse();
    for (let i = 0; i < 5; i++) expect(g.feed(row)).toBeUndefined();
  });

  it("restarts the total for each limited response", () => {
    const g = new ResponseByteGuard(1000);
    const row = dataRow(["x".repeat(90)]);
    g.limitResponse(250);
    expect(g.feed(Buffer.concat([row, row]))).toBeUndefined();
    g.endResponse();
    g.limitResponse(250);
    expect(g.feed(Buffer.concat([row, row]))).toBeUndefined();
  });
});

describe("the one-message limit (#350)", () => {
  it("is MAX_RESULT_BYTES plus the framing allowance, never past V8's string limit", () => {
    expect(messageLimitFor(CAP)).toBe(CAP + MESSAGE_FRAMING_ALLOWANCE);
    expect(messageLimitFor(16 * 1024 * 1024)).toBe(16 * 1024 * 1024 + 64 * 1024);
    expect(messageLimitFor(MAX_MAX_RESULT_BYTES)).toBe(MAX_MAX_RESULT_BYTES);
    expect(messageLimitFor(MAX_MAX_RESULT_BYTES - 10)).toBe(MAX_MAX_RESULT_BYTES);
  });

  it("covers the framing of the widest row the #347 wrapper lets through", () => {
    // 1664 columns plus the running-total column: 4 length bytes + 2 count
    // bytes, 4 bytes per value, and at most 20 digits of the running total.
    // The values themselves are no longer than the row's record text, which
    // the wrapper holds to MAX_RESULT_BYTES.
    expect(MESSAGE_FRAMING_ALLOWANCE).toBeGreaterThan(4 + 2 + 4 * 1665 + 20);
  });
});

/* ------------------------------------------------------------------ */
/* end to end: real pg.Client, loopback database                       */
/* ------------------------------------------------------------------ */

describe("run_select against replies the wrapper cannot bound (#350)", () => {
  it("an EXPLAIN plan row longer than one message may be is an isError, not a crash", async () => {
    const cfg = await cfgFor(() => planRows([`Output: '${"x".repeat(200_000)}'::text`]));
    const r = await runSelect({ sql: "EXPLAIN VERBOSE SELECT repeat('x', 200000) AS w" }, cfg);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^result too large: the database sent a \d+-byte row, over the 66560-byte limit/);
  });

  it("EXPLAIN rows are totalled against MAX_RESULT_BYTES", async () => {
    const cfg = await cfgFor(() => planRows(Array.from({ length: 30 }, (_, i) => `  Output: ${i} ${"y".repeat(100)}`)));
    const r = await runSelect({ sql: "EXPLAIN VERBOSE SELECT 1" }, cfg);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/rows read so far total more than 1024 bytes on the wire, over the MAX_RESULT_BYTES cap/);
  });

  it("an EXPLAIN within MAX_RESULT_BYTES is answered as before", async () => {
    const cfg = await cfgFor(() => planRows(["Result  (cost=0.00..0.01 rows=1 width=4)", "  Output: 1"]));
    const r = await runSelect({ sql: "EXPLAIN VERBOSE SELECT 1" }, cfg);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(text(r)).rows).toEqual([
      { "QUERY PLAN": "Result  (cost=0.00..0.01 rows=1 width=4)" },
      { "QUERY PLAN": "  Output: 1" },
    ]);
  });

  it("an error message quoting a huge value is an isError, not a crash", async () => {
    // Postgres: invalid input syntax for type integer: "xxxx..." (the whole value).
    const cfg = await cfgFor((sql) =>
      sql.startsWith("FETCH") ? [errorResponse(`invalid input syntax for type integer: "${"x".repeat(200_000)}"`)] : [],
    );
    const r = await runSelect({ sql: "SELECT repeat('x', 200000)::int AS w" }, cfg);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^result too large: the database sent a \d+-byte error message/);
  });

  it("an ordinary error is still reported as the database's message", async () => {
    const cfg = await cfgFor((sql) => (sql.startsWith("FETCH") ? [errorResponse("division by zero")] : []));
    const r = await runSelect({ sql: "SELECT 1/0" }, cfg);
    expect(text(r)).toBe("query execution error: division by zero");
  });

  it("does not total a wrapped query's rows on the wire: #347 bounds them in Postgres", async () => {
    // 501 one-digit rows are 1503 bytes of record text ("(1)") but about 9 KB
    // on the wire, over CAP. A wire total here would refuse what #347 allows.
    const cfg = await cfgFor(
      (sql, declared) =>
        sql.startsWith("FETCH")
          ? [
              rowDescription([
                { name: "a", oid: 23 },
                { name: byteColumn(declared), oid: 20 },
              ]),
              ...Array.from({ length: 501 }, (_, i) => dataRow(["1", String(3 * (i + 1))])),
              complete("FETCH 501"),
            ]
          : [],
      500,
    );
    const r = await runSelect({ sql: "SELECT 1 AS a FROM generate_series(1, 1000)" }, cfg);
    expect(r.isError).toBeUndefined();
    const payload = JSON.parse(text(r));
    expect(payload.row_count).toBe(500);
    expect(payload.truncated).toBe(true);
  });

  it("the next call on the same server is answered after a refusal", async () => {
    const cfg = await cfgFor((sql) => planRows([sql.includes("huge") ? `'${"x".repeat(200_000)}'` : "Result"]));
    expect((await runSelect({ sql: "EXPLAIN SELECT 'huge'" }, cfg)).isError).toBe(true);
    const r = await runSelect({ sql: "EXPLAIN SELECT 1" }, cfg);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(text(r)).rows).toEqual([{ "QUERY PLAN": "Result" }]);
  });
});

describe("sample_rows against a row longer than one message may be (#350)", () => {
  it("is an isError naming the limit", async () => {
    const cfg = await cfgFor((sql) =>
      sql.startsWith("SELECT * FROM (")
        ? [
            rowDescription([
              { name: "note", oid: 25 },
              { name: byteColumn(`DECLARE c CURSOR FOR ${sql}`), oid: 20 },
            ]),
            dataRow(["x".repeat(200_000), "200002"]),
            complete("SELECT 1"),
          ]
        : [],
    );
    const r = await sampleRows({ table: "notes" }, cfg);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^result too large: the database sent a \d+-byte row, over the 66560-byte limit/);
  });
});
