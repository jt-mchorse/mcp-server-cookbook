/**
 * Handler isError-contract tests (#102).
 *
 * `postgres-readonly` was the only TS server whose `tools/call` dispatch had
 * no try/catch, so a thrown error — most commonly a connection failure (DB
 * down, wrong/expired `DATABASE_URL`, network/TLS error), since `withClient`
 * runs `validateDbConfig`/`connect`/`SET` outside its own try/finally — escaped
 * out of the handler and the SDK turned it into a JSON-RPC protocol error
 * rather than the documented `isError: true` CallToolResult. The three sibling
 * TS servers all wrap their switch in a catch; `dispatchCallTool` brings this
 * one into parity.
 *
 * Hermetic: no real Postgres. A `DbConfig` pointed at loopback port 1 (nothing
 * listening) makes `client.connect()` fail with an immediate, deterministic
 * `ECONNREFUSED` — the exact "DB unreachable" operational error, exercised
 * without a live server.
 */
import { describe, expect, it } from "vitest";

import type { DbConfig } from "../src/db.js";
import { dispatchCallTool, errorMessage } from "../src/handler.js";

// Valid config shape (passes validateDbConfig) but an unreachable endpoint:
// loopback:1 refuses instantly, so connect() throws before any query runs.
const UNREACHABLE: DbConfig = {
  connectionString: "postgresql://u:p@127.0.0.1:1/nodb",
  maxRows: 100,
  statementTimeoutMs: 1000,
};

const TOOL_CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["describe_schema", { schema: "public" }],
  ["run_select", { sql: "SELECT 1" }],
  ["sample_rows", { table: "t", limit: 5 }],
];

describe("dispatchCallTool — connection failure surfaces as isError, not a throw", () => {
  for (const [name, args] of TOOL_CALLS) {
    it(`${name} returns isError: true instead of throwing when the DB is unreachable`, async () => {
      const result = await dispatchCallTool(name, args, UNREACHABLE);
      expect(result.isError).toBe(true);
      expect(Array.isArray(result.content)).toBe(true);
      // Some human-readable diagnostic text is surfaced (not an empty result).
      const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
      expect(text.length).toBeGreaterThan(0);
    });
  }

  it("an unknown tool still returns isError: true (default arm preserved)", async () => {
    const result = await dispatchCallTool("no_such_tool", {}, UNREACHABLE);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("unknown tool");
  });
});

describe("errorMessage", () => {
  it("surfaces an Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error throw", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });
});
