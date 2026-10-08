/**
 * A `gist_id` of `.` or `..` is a URL dot segment (#241). `encodeURIComponent`
 * leaves `.` alone, and the URL parser inside `fetch` resolves `/gists/.` to
 * `/gists/` and `/gists/..` to `/`, so the token-bearing request went to the
 * gist list or the API root and `get_gist` returned an empty "gist" as success.
 *
 * These arms use the real `fetch` against a loopback server that records every
 * request line, because the resolution happens inside the URL parser, not in
 * anything a fake fetch would see.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { GistsClient } from "../src/client.js";
import type { GistsConfig } from "../src/config.js";

let server: Server | undefined;
let seen: string[] = [];

afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  seen = [];
});

/** A server that answers every request 200 `{}` and records `METHOD path`. */
async function recordingClient(): Promise<GistsClient> {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const cfg: GistsConfig = { token: "ghp_test", baseUrl, userAgent: "ua/0.1", timeoutMs: 2_000 };
  return new GistsClient({ cfg, fetch: globalThis.fetch as never });
}

describe("gist_id dot segments are refused before any request (#241)", () => {
  it.each([".", "..", " .. ", "\t.\n"])("get_gist(%j) is refused and sends nothing", async (id) => {
    const c = await recordingClient();
    const err = await c.getGist(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^gist_id must not be a path dot segment; got "\.\.?"$/);
    expect(seen).toEqual([]);
  });

  it.each([".", ".."])("update_gist_file(%j) is refused and sends nothing", async (id) => {
    const c = await recordingClient();
    const err = await c
      .updateGistFile({ gistId: id, filename: "a.md", content: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^gist_id must not be a path dot segment/);
    expect(seen).toEqual([]);
  });

  // Controls: an id that merely contains dots is not a dot segment, and still
  // reaches `/gists/<id>` verbatim -- the refusal is exactly the two segments.
  it.each([
    ["abc123", "GET /gists/abc123"],
    ["...", "GET /gists/..."],
  ])("get_gist(%j) still requests %s", async (id, expected) => {
    const c = await recordingClient();
    await c.getGist(id);
    expect(seen).toEqual([expected]);
  });
});
