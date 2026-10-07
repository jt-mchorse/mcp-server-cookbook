/**
 * A database that accepts and never answers fails the tool call within a
 * bound (#229).
 *
 * `statement_timeout` is a server setting, sent only after `connect()`
 * succeeds, and `pg.Client` waits forever by default: against a host that
 * accepted TCP and stayed silent, `withClient` was still pending after 8 s with
 * `statementTimeoutMs: 1000`. A loopback listener stands in for the host -- no
 * database needed.
 */
import net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CONNECT_TIMEOUT_FLOOR_MS, withClient } from "../src/db.js";

const sockets: net.Socket[] = [];
let listener: net.Server | undefined;

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await new Promise<void>((done) => (listener ? listener.close(() => done()) : done()));
  listener = undefined;
});

async function silentDatabase(): Promise<string> {
  listener = net.createServer((s) => sockets.push(s));
  await new Promise<void>((done) => listener!.listen(0, "127.0.0.1", () => done()));
  return `postgresql://u:p@127.0.0.1:${(listener!.address() as AddressInfo).port}/x`;
}

describe("withClient against a silent database (#229)", () => {
  it("rejects within the connect budget instead of hanging", async () => {
    const started = Date.now();
    const err = await withClient(
      { connectionString: await silentDatabase(), statementTimeoutMs: 1000, maxRows: 10 },
      async (c) => c.query("select 1"),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const elapsed = Date.now() - started;
    // The connect budget is max(statementTimeoutMs, the floor).
    expect(elapsed).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_FLOOR_MS - 100);
    expect(elapsed).toBeLessThan(CONNECT_TIMEOUT_FLOOR_MS + 3_000);
  }, 20_000);

});
