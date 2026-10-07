/**
 * The two upstream failures that reached the MCP client as raw runtime text
 * (#231). A refused connection surfaced as `fetch failed` -- undici keeps the
 * reason on `err.cause` -- and a 200 carrying an HTML page (a proxy, a captive
 * portal) surfaced as `Unexpected token '<', "<html>..." is not valid JSON`.
 * Neither named the request. These arms use the real `fetch` against real
 * sockets, because the shape of the rejection is undici's, not a fake's.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  type FetchLike,
  GistsClient,
  GithubApiError,
  RequestTimeoutError,
  UpstreamUnreachableError,
} from "../src/client.js";
import type { GistsConfig } from "../src/config.js";

const TOKEN = "ghp_secret_should_never_appear";
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

function client(baseUrl: string, fetch: FetchLike = globalThis.fetch as never): GistsClient {
  const cfg: GistsConfig = { token: TOKEN, baseUrl, userAgent: "ua/0.1", timeoutMs: 2_000 };
  return new GistsClient({ cfg, fetch });
}

/** A port that was just listening and is now closed, so a connect is refused. */
async function refusedBaseUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", () => done()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((done) => s.close(() => done()));
  return `http://127.0.0.1:${port}`;
}

async function htmlServer(status: number): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end("<html>proxy login required</html>");
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("a connection that never gets a response (#231)", () => {
  it("get_gist: a refused connection names the request and ECONNREFUSED, not 'fetch failed'", async () => {
    const base = await refusedBaseUrl();
    const err = await client(base).getGist("abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnreachableError);
    const msg = (err as Error).message;
    expect(msg.startsWith("upstream_unreachable (GET /gists/abc): ")).toBe(true);
    expect(msg).toContain("ECONNREFUSED");
    expect(msg).not.toContain(TOKEN);
  });

  it("update_gist_file: the PATCH path is wrapped the same way", async () => {
    const err = await client(await refusedBaseUrl())
      .updateGistFile({ gistId: "abc", filename: "a.md", content: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnreachableError);
    expect((err as Error).message).toMatch(/^upstream_unreachable \(PATCH \/gists\/abc\): .*ECONNREFUSED/);
  });

  it("a rejection with no cause still names the request and keeps its own text", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("network down");
    };
    const err = await client("https://api.github.test", fetch).getGist("abc").catch((e: unknown) => e);
    expect((err as Error).message).toBe("upstream_unreachable (GET /gists/abc): network down");
  });

  it("our own abort is still request_timed_out, not upstream_unreachable", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        );
      });
    const cfg: GistsConfig = { token: null, baseUrl: "https://api.github.test", userAgent: "ua", timeoutMs: 50 };
    const err = await new GistsClient({ cfg, fetch }).getGist("abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
  });
});

describe("a 2xx whose body is not JSON (#231)", () => {
  it("get_gist: an HTML 200 is a github_api_error naming the request, with none of the page", async () => {
    const err = await client(await htmlServer(200)).getGist("abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as Error).message).toBe("github_api_error (200 GET /gists/abc): response was not JSON");
    expect((err as Error).message).not.toContain("proxy");
  });

  it("update_gist_file: the PATCH success body is checked the same way", async () => {
    const err = await client(await htmlServer(200))
      .updateGistFile({ gistId: "abc", filename: "a.md", content: "x" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("github_api_error (200 PATCH /gists/abc): response was not JSON");
  });

  it("a non-2xx HTML page keeps the existing reason path (control)", async () => {
    const err = await client(await htmlServer(502)).getGist("abc").catch((e: unknown) => e);
    expect((err as Error).message).toBe("github_api_error (502 GET /gists/abc): <html>proxy login required</html>");
  });
});
