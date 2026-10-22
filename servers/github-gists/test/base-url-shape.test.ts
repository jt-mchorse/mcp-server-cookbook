/**
 * A base URL that `baseUrl + "/gists/<id>"` cannot join is refused at boot (#316).
 *
 * The env path trims `MCP_GITHUB_GISTS_BASE_URL` and strips a trailing slash;
 * a built `GistsConfig` was only checked for parseability. Each shape below
 * booted, then failed every call, measured against a loopback server that
 * records the path it was sent: a trailing `/` requested `//gists/<id>`, a
 * trailing space failed in `fetch` with `ERR_INVALID_URL`, and a `?` or `#`
 * sent the request to the API root while the error named `/gists/<id>`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GistsClient } from "../src/client.js";
import { type GistsConfig, readGistsConfigFromEnv, validateGistsConfig } from "../src/config.js";

// (label, base URL) — the four rows of #316, plus the bare `?`/`#` whose
// `url.search`/`url.hash` are `""`, which a gate on the parsed URL would miss.
const UNJOINABLE: Array<[string, string]> = [
  ["a trailing slash", "https://api.github.com/"],
  ["a trailing space", "https://api.github.com "],
  ["a fragment", "https://api.github.com/#x"],
  ["a query", "https://api.github.com?x="],
  ["a bare #", "https://api.github.com#"],
  ["a bare ?", "https://api.github.com?"],
  ["a key in the query", "https://ghe.example.test/api/v3?access_token=KEY42"],
];

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
}

function cfgWith(baseUrl: string): GistsConfig {
  return { token: null, baseUrl, userAgent: "ua/0.1", timeoutMs: 2_000 };
}

describe("a built GistsConfig.baseUrl the request builder cannot join is refused (#316)", () => {
  it.each(UNJOINABLE)("by validateGistsConfig: %s", (_label, baseUrl) => {
    const message = messageOf(() => validateGistsConfig(cfgWith(baseUrl)));
    expect(message).toMatch(/^GistsConfig\.baseUrl (has|ends)/);
  });

  it.each(UNJOINABLE)("by the GistsClient constructor: %s", (_label, baseUrl) => {
    // The path #316 measured: on main this constructed and every call failed.
    expect(messageOf(() => new GistsClient({ cfg: cfgWith(baseUrl) }))).toMatch(
      /^GistsConfig\.baseUrl/,
    );
  });

  it("does not quote a query, which may hold a key, but names the host", () => {
    const message = messageOf(() => validateGistsConfig(cfgWith(UNJOINABLE[6]![1])));
    expect(message).not.toContain("KEY42");
    expect(message).toContain('"ghe.example.test"');
  });

  it.each([
    ["the default", "https://api.github.com"],
    ["a GHES-style path prefix", "http://localhost:8080/api/v3"],
    ["loopback with a port", "http://127.0.0.1:9"],
  ])("still accepts %s", (_label, baseUrl) => {
    // The control: a gate that refused every URL would pass every row above.
    expect(() => validateGistsConfig(cfgWith(baseUrl))).not.toThrow();
  });
});

describe("the env path names its own variable (#316)", () => {
  it.each([
    ["a fragment", "https://api.github.com/#x"],
    ["a query", "https://api.github.com?x="],
    ["two trailing slashes (one is stripped)", "https://api.github.com//"],
  ])("refuses %s as MCP_GITHUB_GISTS_BASE_URL", (_label, raw) => {
    // On main a `?`/`#` booted from the env too; with only the built-config
    // gate it would have been refused under `GistsConfig.baseUrl`.
    const message = messageOf(() => readGistsConfigFromEnv({ MCP_GITHUB_GISTS_BASE_URL: raw }));
    expect(message).toMatch(/^MCP_GITHUB_GISTS_BASE_URL (has|ends)/);
  });

  it.each([
    ["one trailing slash", "https://api.github.com/", "https://api.github.com"],
    ["surrounding whitespace", "  https://ghe.example.test/api/v3/ ", "https://ghe.example.test/api/v3"],
  ])("still normalises %s, and the result passes the built-config gate", (_label, raw, expected) => {
    const cfg = readGistsConfigFromEnv({ MCP_GITHUB_GISTS_BASE_URL: raw });
    expect(cfg.baseUrl).toBe(expected);
    expect(() => validateGistsConfig(cfg)).not.toThrow();
  });
});

describe("an accepted base URL requests the path it names (#316)", () => {
  let server: Server;
  let origin: string;
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"message":"Not Found"}');
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  // `%09` is the way to put a tab in a path: it is sent as written, so the #326
  // gate on a raw TAB/LF/CR must not refuse it.
  it.each([
    ["the origin", ""],
    ["a GHES-style path prefix", "/api/v3"],
    ["a percent-encoded tab (#326 control)", "/api%09v3"],
  ])(
    "%s",
    async (_label, prefix) => {
      seen.length = 0;
      const client = new GistsClient({ cfg: cfgWith(origin + prefix) });
      await expect(client.getGist("abc123")).rejects.toThrow(/404 GET \/gists\/abc123/);
      expect(seen).toEqual([`${prefix}/gists/abc123`]);
    },
  );
});

/**
 * A TAB, LF or CR inside the base URL is refused, not deleted (#326).
 *
 * #316 refused whitespace at the ends; the inside was still repaired. The URL
 * parser deletes every ASCII TAB, LF and CR, so on 644d772 a base URL of
 * `<origin>/api<TAB>v3` (and LF, and CR) booted from the env and as a built
 * config, and a loopback server was sent `/apiv3/gists/abc123`.
 */
const INTERIOR: Array<[string, string]> = [
  ["a tab", "\t"],
  ["a line feed", "\n"],
  ["a carriage return", "\r"],
];

describe("a TAB, LF or CR inside the base URL is refused (#326)", () => {
  it.each(INTERIOR)("by validateGistsConfig: %s", (_label, ch) => {
    const message = messageOf(() => validateGistsConfig(cfgWith(`https://ghe.example.test/api${ch}v3`)));
    expect(message).toMatch(/^GistsConfig\.baseUrl contains a tab, line feed or carriage return/);
    expect(message).toContain('"ghe.example.test"');
  });

  it.each(INTERIOR)("from MCP_GITHUB_GISTS_BASE_URL: %s", (_label, ch) => {
    const message = messageOf(() =>
      readGistsConfigFromEnv({ MCP_GITHUB_GISTS_BASE_URL: `https://ghe.example.test/api${ch}v3` }),
    );
    expect(message).toMatch(/^MCP_GITHUB_GISTS_BASE_URL contains a tab, line feed or carriage return/);
  });

  it("in the host as well as the path", () => {
    expect(messageOf(() => validateGistsConfig(cfgWith("https://api.git\thub.com")))).toMatch(
      /contains a tab, line feed or carriage return/,
    );
  });
});
