/**
 * The per-call timeout covers the response body, not just the headers (#227).
 *
 * `request` cleared its abort timer as soon as `fetch` resolved -- when the
 * HEADERS arrive -- and the body was read after that with no deadline. A
 * server that sent headers and then stalled its body hung `get_gist` forever
 * (measured over stdio: no reply after 8 s with `MCP_GITHUB_GISTS_TIMEOUT_MS`
 * 1000), under a README that promises `request_timed_out` "rather than
 * hanging". These arms use the real `fetch` against a real socket, because
 * the stall lives in the stream, which a fake fetch cannot reproduce.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { GistsClient, RequestTimeoutError } from "../src/client.js";
import type { GistsConfig } from "../src/config.js";

const held: ServerResponse[] = [];
let server: Server | undefined;

afterEach(async () => {
  for (const res of held.splice(0)) res.destroy();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

async function stalling(status: number, partial: string): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.write(partial); // ...and never end
    held.push(res);
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function client(baseUrl: string, token: string | null = null): GistsClient {
  const cfg: GistsConfig = { token, baseUrl, userAgent: "ua/0.1", timeoutMs: 300 };
  return new GistsClient({ cfg, fetch: globalThis.fetch as never });
}

describe("a body that stalls after the headers (#227)", () => {
  it("get_gist: a 200 whose JSON body stalls is request_timed_out, within the timeout", async () => {
    const started = Date.now();
    const err = await client(await stalling(200, '{"id":"abc","fil'))
      .getGist("abc")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as Error).message).toBe("request_timed_out (GET /gists/abc, 300ms)");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("get_gist: a 502 whose error body stalls is request_timed_out, not a hang in reasonFromResponse", async () => {
    const err = await client(await stalling(502, '{"message":"bad ga'))
      .getGist("abc")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
  });

  it("update_gist_file: the PATCH body read is covered too", async () => {
    const err = await client(await stalling(200, '{"id":'), "ghp_test")
      .updateGistFile({ gistId: "abc", filename: "a.md", content: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as Error).message).toBe("request_timed_out (PATCH /gists/abc, 300ms)");
  });
});
