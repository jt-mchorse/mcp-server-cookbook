/**
 * `GithubApiError` redacts the token from, and caps, the upstream text it
 * carries (#307).
 *
 * #305 redacted three surfaces one at a time. Two more built error text from
 * upstream data with neither step. Measured on `main` 8897182 against a
 * loopback server that echoes the `Authorization` header (the #305 threat
 * model: a header-echoing proxy or a mis-set base URL):
 *
 *     get_gist          -> response was not a gist: file "Bearer ghp_..." is not an object
 *     update_gist_file  -> the same
 *     a 100k file name  -> a 100,088-character message
 *     401 + X-GitHub-Request-Id: Bearer <token>  -> ... | request-id=Bearer ghp_...
 *
 * Both now pass through the constructor, which every surface reaches.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { type FetchLike, formatGithubApiError, GistsClient, GithubApiError } from "../src/client.js";
import type { GistsConfig } from "../src/config.js";

const SECRET = "ghp_secret_should_never_appear";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

type Handler = (auth: string, req: IncomingMessage, res: ServerResponse) => void;

async function client(token: string | null, handler: Handler): Promise<GistsClient> {
  server = createServer((req, res) => handler(req.headers.authorization ?? "", req, res));
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const cfg: GistsConfig = { token, baseUrl, userAgent: "ua/0.1", timeoutMs: 2_000 };
  return new GistsClient({ cfg, fetch: globalThis.fetch as never });
}

/** A 200 whose `files` map has one non-object entry under `name`. */
function notAGist(name: (auth: string) => string, headers: Record<string, string> = {}): Handler {
  return (auth, _req, res) => {
    res.writeHead(200, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ id: "abc", files: { [name(auth)]: "not an object" } }));
  };
}

async function apiError(p: Promise<unknown>): Promise<{ err: GithubApiError; text: string }> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GithubApiError);
  const e = err as GithubApiError;
  return { err: e, text: formatGithubApiError(e) };
}

describe("a gist-shape reason that quotes the token is redacted (#307)", () => {
  it("on get_gist", async () => {
    const c = await client(SECRET, notAGist((auth) => auth));
    const { err, text } = await apiError(c.getGist("abc"));
    expect(text).not.toContain(SECRET);
    expect(err.reason).toBe('response was not a gist: file "Bearer [REDACTED]" is not an object');
  });

  it("on update_gist_file", async () => {
    const c = await client(SECRET, notAGist((auth) => auth));
    const { err, text } = await apiError(c.updateGistFile({ gistId: "abc", filename: "f.md", content: "hi" }));
    expect(text).not.toContain(SECRET);
    expect(err.reason).toBe('response was not a gist: file "Bearer [REDACTED]" is not an object');
  });

  it("a 100k-character file name is capped", async () => {
    const c = await client(SECRET, notAGist(() => "n".repeat(100_000)));
    const { err, text } = await apiError(c.getGist("abc"));
    expect(err.reason.length).toBeLessThanOrEqual(301);
    expect(err.reason.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(400);
  });
});

describe("a request id that quotes the token is redacted (#307)", () => {
  it("on a non-2xx response", async () => {
    const c = await client(SECRET, (auth, _req, res) => {
      res.writeHead(401, { "content-type": "application/json", "X-GitHub-Request-Id": auth });
      res.end("{}");
    });
    const { err, text } = await apiError(c.getGist("abc"));
    expect(text).not.toContain(SECRET);
    expect(err.requestId).toBe("Bearer [REDACTED]");
    expect(text).toBe("github_api_error (401 GET /gists/abc): {} | request-id=Bearer [REDACTED]");
  });

  it("on a 2xx that is not a gist", async () => {
    const c = await client(SECRET, notAGist(() => "f.md", { "X-GitHub-Request-Id": `id ${SECRET}` }));
    const { err, text } = await apiError(c.getGist("abc"));
    expect(text).not.toContain(SECRET);
    expect(err.requestId).toBe("id [REDACTED]");
  });

  it("a long request id is capped", async () => {
    const c = await client(SECRET, (_auth, _req, res) => {
      res.writeHead(404, { "content-type": "application/json", "X-GitHub-Request-Id": "r".repeat(5_000) });
      res.end('{"message":"Not Found"}');
    });
    const { err } = await apiError(c.getGist("abc"));
    expect(err.requestId!.length).toBeLessThanOrEqual(301);
    expect(err.requestId!.endsWith("…")).toBe(true);
  });
});

describe("text without the token is unchanged (controls)", () => {
  it("a short non-object file name is still named", async () => {
    const c = await client(SECRET, notAGist(() => "notes.md"));
    const { err } = await apiError(c.getGist("abc"));
    expect(err.reason).toBe('response was not a gist: file "notes.md" is not an object');
  });

  it("an ordinary request id is reported as sent", async () => {
    const c = await client(SECRET, (_auth, _req, res) => {
      res.writeHead(404, { "content-type": "application/json", "X-GitHub-Request-Id": "C0DE:1A2B:3C4D:5E6F" });
      res.end('{"message":"Not Found"}');
    });
    const { text } = await apiError(c.getGist("abc"));
    expect(text).toBe("github_api_error (404 GET /gists/abc): Not Found | request-id=C0DE:1A2B:3C4D:5E6F");
  });

  it("a client without a token redacts nothing", async () => {
    const c = await client(null, notAGist(() => "Bearer x"));
    const { err } = await apiError(c.getGist("abc"));
    expect(err.reason).toBe('response was not a gist: file "Bearer x" is not an object');
  });

  it("a reason a surface capped at 200 behind a prefix is not cut again", async () => {
    // The body-read path puts a fixed prefix before a description already
    // capped at 200, so its reason runs past 200. A constructor cap of 200
    // instead of the backstop would cut it a second time.
    const fetch: FetchLike = async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => "",
      json: async () => {
        throw new Error("e".repeat(500));
      },
    });
    const cfg: GistsConfig = { token: SECRET, baseUrl: "https://api.github.test", userAgent: "ua/0.1", timeoutMs: 2_000 };
    const { err } = await apiError(new GistsClient({ cfg, fetch }).getGist("abc"));
    expect(err.reason).toBe(`response body could not be read: ${"e".repeat(200)}…`);
  });
});
