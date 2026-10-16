/**
 * A 2xx whose body is cut off after the headers (#291). The peer dropping the
 * connection mid-body made `res.json()` reject with undici's bare `terminated`,
 * and that text reached the client naming no request -- the surface #231's
 * wrapping did not list (it covered a rejection before any response and a body
 * that is not JSON). These arms use the real `fetch` against a real socket,
 * because the shape of the rejection is undici's, not a fake's.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { GistsClient, GithubApiError, RequestTimeoutError } from "../src/client.js";
import type { GistsConfig } from "../src/config.js";

const TOKEN = "ghp_secret_should_never_appear";
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/** Answers `status` promising 1000 bytes, writes a JSON prefix, then drops or stalls the socket. */
async function cutBodyServer(status: number, after: "destroy" | "stall"): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json", "content-length": "1000" });
    res.write('{"id":"abc","files":{');
    if (after === "destroy") setTimeout(() => res.socket?.destroy(), 20);
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function client(baseUrl: string, timeoutMs = 2_000): GistsClient {
  const cfg: GistsConfig = { token: TOKEN, baseUrl, userAgent: "ua/0.1", timeoutMs };
  return new GistsClient({ cfg });
}

describe("a 2xx body the peer cuts off mid-read (#291)", () => {
  it("get_gist names the status and the request, and keeps undici's cause", async () => {
    const err = await client(await cutBodyServer(200, "destroy"))
      .getGist("abc")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    const msg = (err as Error).message;
    expect(msg.startsWith("github_api_error (200 GET /gists/abc): response body could not be read: ")).toBe(
      true,
    );
    expect(msg).toContain("UND_ERR_SOCKET");
    expect(msg).not.toBe("terminated");
    expect(msg).not.toContain(TOKEN);
  });

  it("update_gist_file: the PATCH success body is read the same way", async () => {
    const err = await client(await cutBodyServer(200, "destroy"))
      .updateGistFile({ gistId: "abc", filename: "a.md", content: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as Error).message).toMatch(
      /^github_api_error \(200 PATCH \/gists\/abc\): response body could not be read: .*UND_ERR_SOCKET/,
    );
  });

  it("our own abort mid-body is still request_timed_out (control)", async () => {
    const err = await client(await cutBodyServer(200, "stall"), 150)
      .getGist("abc")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as Error).message).toBe("request_timed_out (GET /gists/abc, 150ms)");
  });
});
