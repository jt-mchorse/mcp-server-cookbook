/**
 * A database connection lost mid-query is an isError, and the server keeps
 * answering (#352).
 *
 * Before #351, `withClient` attached no `error` listener to its `pg.Client`.
 * When the socket closes without `client.end()` having been called, pg's `end`
 * handler rejects the active query and then emits `error` on the client. With
 * no listener that emit throws, so the process exits. Measured on PostgreSQL
 * 18.0 over stdio, on d56ecfa (the commit before #351), with `run_select`
 * running a long `generate_series` count:
 *
 *   backend SIGKILLed (the socket closes, no ErrorResponse)
 *     -> "Unhandled 'error' event ... Connection terminated unexpectedly",
 *        exit 1, the call never answered
 *   pg_terminate_backend (FATAL 57P01, then the socket closes)
 *     -> isError, next call answered. This one did not crash: the FATAL
 *        rejects the query first, and `withClient`'s `finally` calls
 *        `client.end()` before the close arrives, so pg does not emit.
 *
 * #351 added a no-op listener for its own socket destroy, and that covers this
 * path too. These tests pin what each tool returns when the connection drops,
 * that the next call is answered, and that the next call opens a new
 * connection. The last arm spawns the real server, because in-process an
 * unhandled emit shows up only as a vitest "unhandled error", not as a failed
 * test.
 *
 * Hermetic: the real `pg.Client` against a loopback listener that speaks just
 * enough of the Postgres protocol. No database.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { dispatchCallTool } from "../src/handler.js";
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

function rowDescription(names: string[]): Buffer {
  const parts = [Buffer.from([names.length >> 8, names.length & 0xff])];
  for (const name of names) {
    const meta = Buffer.alloc(18);
    meta.writeUInt32BE(23, 6); // int4
    meta.writeInt16BE(4, 10);
    meta.writeInt32BE(-1, 12);
    parts.push(cstring(name), meta);
  }
  return message("T", Buffer.concat(parts));
}

function dataRow(values: string[]): Buffer {
  const parts = [Buffer.from([values.length >> 8, values.length & 0xff])];
  for (const v of values) {
    const len = Buffer.alloc(4);
    len.writeInt32BE(Buffer.byteLength(v), 0);
    parts.push(len, Buffer.from(v, "utf8"));
  }
  return message("D", Buffer.concat(parts));
}

/** What Postgres sends a backend killed by pg_terminate_backend or a fast shutdown, before it closes. */
const adminShutdown = () =>
  message(
    "E",
    Buffer.concat([
      Buffer.from("S"),
      cstring("FATAL"),
      Buffer.from("V"),
      cstring("FATAL"),
      Buffer.from("C"),
      cstring("57P01"),
      Buffer.from("M"),
      cstring("terminating connection due to administrator command"),
      Buffer.from([0]),
    ]),
  );

const complete = (tag: string) => message("C", cstring(tag));
const ready = () => message("Z", Buffer.from("I"));

/* ------------------------------------------------------------------ */
/* a loopback "database" that can drop the connection                  */
/* ------------------------------------------------------------------ */

/**
 * How the fake ends a connection: `fin` closes it with no message (a backend
 * that died), `rst` resets it (a network reset), `fatal` sends the 57P01
 * ErrorResponse and then closes it (pg_terminate_backend, a fast shutdown).
 */
type Drop = "fin" | "rst" | "fatal";
type Answer = Buffer[] | Drop;

interface FakeDatabase {
  url: string;
  /** Connections accepted so far. */
  connections: () => number;
}

const sockets: net.Socket[] = [];
let listener: net.Server | undefined;

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await new Promise<void>((done) => (listener ? listener.close(() => done()) : done()));
  listener = undefined;
});

function drop(s: net.Socket, how: Drop): void {
  if (how === "rst") s.resetAndDestroy();
  else if (how === "fatal") s.end(adminShutdown());
  else s.end();
}

/**
 * Answers the startup message with AuthenticationOk, BEGIN/COMMIT/DECLARE with
 * their tags, and every other message through `answer(what, connection)`:
 * `what` is a simple query's text, or "extended" for the first message of an
 * extended-protocol query (describe_schema's parameterised ones). `connection`
 * counts from 1, so an answer can drop the first connection and serve the next.
 */
async function fakeDatabase(answer: (what: string, connection: number) => Answer): Promise<FakeDatabase> {
  let accepted = 0;
  listener = net.createServer((s) => {
    sockets.push(s);
    const connection = ++accepted;
    s.on("error", () => {});
    let buf = Buffer.alloc(0);
    let started = false;
    s.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (!s.destroyed && !s.writableEnded) {
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
        if (type === "P") {
          // Parse: only drops are scripted for the extended protocol.
          const out = answer("extended", connection);
          if (!Array.isArray(out)) drop(s, out);
          continue;
        }
        if (type !== "Q") continue;
        const sql = body.toString("utf8").replace(/\0$/, "");
        const tag = /^(BEGIN|COMMIT|DECLARE)\b/.exec(sql)?.[1];
        const out = tag ? [complete(tag === "DECLARE" ? "DECLARE CURSOR" : tag)] : answer(sql, connection);
        if (Array.isArray(out)) s.write(Buffer.concat([...out, ready()]));
        else drop(s, out);
      }
    });
  });
  await new Promise<void>((done) => listener!.listen(0, "127.0.0.1", () => done()));
  return {
    url: `postgresql://u:p@127.0.0.1:${(listener!.address() as AddressInfo).port}/x`,
    connections: () => accepted,
  };
}

/** SETs succeed; the first connection drops `how` at the query `at` matches, later ones answer `SELECT 1`. */
async function droppingOnce(how: Drop, at: (what: string) => boolean): Promise<FakeDatabase> {
  return fakeDatabase((what, connection) => {
    if (connection === 1 && at(what)) return how;
    if (what.startsWith("SET ")) return [complete("SET")];
    // Without the #347 running-total column, which the tool drops only when present.
    return [rowDescription(["one"]), dataRow(["1"]), complete("FETCH 1")];
  });
}

const atFetch = (what: string) => what.startsWith("FETCH");

function cfg(db: FakeDatabase) {
  return { connectionString: db.url, maxRows: 10, statementTimeoutMs: 3000 };
}

function text(r: { content: Array<{ text: string }> }): string {
  return r.content[0]!.text;
}

const NEXT_CALL = { sql: "SELECT 1 AS one" };

function expectAnswered(r: { isError?: boolean; content: Array<{ text: string }> }): void {
  expect(r.isError).toBeUndefined();
  expect(JSON.parse(text(r)).rows).toEqual([{ one: 1 }]);
}

/* ------------------------------------------------------------------ */
/* in process                                                          */
/* ------------------------------------------------------------------ */

describe("run_select when the connection drops mid-query (#352)", () => {
  it("a backend that dies (socket closed, no message) is an isError naming the drop", async () => {
    const db = await droppingOnce("fin", atFetch);
    const r = await runSelect({ sql: "SELECT count(*) AS n FROM generate_series(1, 2000000000) g" }, cfg(db));
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("query execution error: Connection terminated unexpectedly");
  });

  it("a connection reset is an isError naming the reset", async () => {
    const db = await droppingOnce("rst", atFetch);
    const r = await runSelect({ sql: "SELECT 1 AS one" }, cfg(db));
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("query execution error: read ECONNRESET");
  });

  it("an administrator's termination (FATAL 57P01) is an isError with the database's message", async () => {
    const db = await droppingOnce("fatal", atFetch);
    const r = await runSelect({ sql: "SELECT 1 AS one" }, cfg(db));
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("query execution error: terminating connection due to administrator command");
  });

  it.each<Drop>(["fin", "rst", "fatal"])("after a %s drop the next call is answered on a new connection", async (how) => {
    const db = await droppingOnce(how, atFetch);
    expect((await runSelect(NEXT_CALL, cfg(db))).isError).toBe(true);
    expect(db.connections()).toBe(1);
    expectAnswered(await runSelect(NEXT_CALL, cfg(db)));
    expect(db.connections()).toBe(2);
  });
});

describe("the other tools when the connection drops (#352)", () => {
  it("sample_rows: an isError naming the drop, then the next call is answered", async () => {
    const db = await droppingOnce("fin", (what) => what.startsWith("SELECT * FROM ("));
    const r = await sampleRows({ table: "notes" }, cfg(db));
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("sample_rows error: Connection terminated unexpectedly");
    expectAnswered(await runSelect(NEXT_CALL, cfg(db)));
    expect(db.connections()).toBe(2);
  });

  it("describe_schema: an isError naming the drop, then the next call is answered", async () => {
    const db = await droppingOnce("fin", (what) => what === "extended");
    const r = await dispatchCallTool("describe_schema", {}, cfg(db));
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual({ type: "text", text: "Connection terminated unexpectedly" });
    expectAnswered(await runSelect(NEXT_CALL, cfg(db)));
    expect(db.connections()).toBe(2);
  });

  it("a drop during the session SETs, before the tool's query: an isError, then the next call is answered", async () => {
    const db = await droppingOnce("fin", (what) => what.startsWith("SET statement_timeout"));
    const r = await dispatchCallTool("run_select", NEXT_CALL, cfg(db));
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual({ type: "text", text: "Connection terminated unexpectedly" });
    expectAnswered(await runSelect(NEXT_CALL, cfg(db)));
    expect(db.connections()).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* the real server process                                             */
/* ------------------------------------------------------------------ */

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

/** The dropped call's text for each kind of drop, as the tests above pin it. */
const DROPPED_TEXT: Record<Drop, string> = {
  fin: "query execution error: Connection terminated unexpectedly",
  rst: "query execution error: read ECONNRESET",
  fatal: "query execution error: terminating connection due to administrator command",
};

describe("the server process survives a dropped connection (#352)", () => {
  // `fatal` did not crash before #351 either (see the top of this file); it is
  // here so all three drops are pinned at the process level.
  it.each<Drop>(["fin", "rst", "fatal"])(
    "%s: answers the dropped call with an isError and the next call with rows, without exiting",
    async (how) => {
      const db = await droppingOnce(how, atFetch);
      const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: db.url };
      for (const key of ["MAX_ROWS", "STATEMENT_TIMEOUT_MS", "MAX_RESULT_BYTES"]) delete env[key];
      // tsx, not dist/: CI runs the tests before the build (see boot-config-failure).
      const child = spawn(process.execPath, [TSX_CLI, SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      let exit: string | undefined;
      const replies = new Map<number, { result?: { isError?: boolean; content: Array<{ text: string }> } }>();
      const waiting = new Map<number, () => void>();
      let out = "";
      child.stdout.on("data", (d) => {
        out += String(d);
        for (let i = out.indexOf("\n"); i >= 0; i = out.indexOf("\n")) {
          const msg = JSON.parse(out.slice(0, i));
          out = out.slice(i + 1);
          replies.set(msg.id, msg);
          waiting.get(msg.id)?.();
        }
      });
      child.stderr.on("data", (d) => (stderr += String(d)));
      const exited = new Promise<void>((done) =>
        child.on("exit", (code, signal) => {
          exit = `code ${code}, signal ${signal}`;
          done();
        }),
      );
      const call = async (id: number, method: string, params: unknown) => {
        const answered = new Promise<void>((done) => waiting.set(id, done));
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        await Promise.race([answered, exited]);
        return replies.get(id);
      };
      try {
        await call(1, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "connection-drop-test", version: "0" },
        });
        const dropped = await call(2, "tools/call", { name: "run_select", arguments: NEXT_CALL });
        const next = await call(3, "tools/call", { name: "run_select", arguments: NEXT_CALL });
        expect(exit, `server exited:\n${stderr}`).toBeUndefined();
        expect(dropped?.result?.isError).toBe(true);
        expect(dropped?.result?.content[0]?.text).toBe(DROPPED_TEXT[how]);
        expectAnswered(next!.result!);
        expect(db.connections()).toBe(2);
      } finally {
        child.kill();
      }
    },
    20_000,
  );
});
