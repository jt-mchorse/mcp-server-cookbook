/**
 * A User-Agent `fetch` would refuse is refused at boot (#271).
 *
 * #264 gave `GITHUB_TOKEN` a boot gate for characters a header cannot carry.
 * `MCP_GITHUB_GISTS_USER_AGENT` is the config's other header value, and it was
 * trimmed at the ends only: a CR, LF or NUL inside it, or a character above
 * U+00FF, booted, then every call failed inside undici as
 * `upstream_unreachable`. The rule is the one a real `fetch` applies, so the
 * accepted rows below are sent to a loopback server and must arrive.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GistsClient } from "../src/client.js";
import { type GistsConfig, readGistsConfigFromEnv, validateGistsConfig } from "../src/config.js";

const ch = (code: number): string => String.fromCharCode(code);

// (label, code point) — a loopback `fetch` rejects each of these. SOH and DEL
// pass `new Headers()` and are refused later, by undici's request layer.
const REFUSED: Array<[string, number]> = [
  ["NUL", 0x00],
  ["SOH", 0x01],
  ["LF", 0x0a],
  ["CR", 0x0d],
  ["US", 0x1f],
  ["DEL", 0x7f],
  ["U+0100, the first code point past Latin-1", 0x100],
  ["a Cyrillic letter", 0x0416],
  ["U+2028 line separator", 0x2028],
  ["half of a surrogate pair", 0xd83d],
];

// (label, code point) — `fetch` sends each of these, so the gate must not refuse them.
const SENT: Array<[string, number]> = [
  ["TAB", 0x09],
  ["space", 0x20],
  ["U+0080", 0x80],
  ["e-acute", 0xe9],
  ["U+00FF, the last Latin-1 code point", 0xff],
];

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
}

function cfgWith(userAgent: string, baseUrl = "https://api.github.test"): GistsConfig {
  return { token: null, baseUrl, userAgent, timeoutMs: 2_000 };
}

describe("a User-Agent a header cannot carry is refused (#271)", () => {
  it.each(REFUSED)("from the environment: %s", (_label, code) => {
    const message = messageOf(() =>
      readGistsConfigFromEnv({ MCP_GITHUB_GISTS_USER_AGENT: `my-app/1.0${ch(code)}x` }),
    );
    const hex = code.toString(16).toUpperCase().padStart(4, "0");
    expect(message).toContain(`MCP_GITHUB_GISTS_USER_AGENT contains U+${hex} at position 10`);
  });

  it.each(REFUSED)("by the GistsClient constructor: %s", (_label, code) => {
    // The path #271 measured: on main this constructed, and every call failed.
    const message = messageOf(() => new GistsClient({ cfg: cfgWith(`my-app/1.0${ch(code)}x`) }));
    expect(message).toMatch(/^GistsConfig\.userAgent contains U\+[0-9A-F]{4} at position 10/);
  });

  it("the whole surrogate pair (an emoji) is refused too, as fetch refuses it", () => {
    expect(() => validateGistsConfig(cfgWith(`my-app/1.0${String.fromCodePoint(0x1f600)}`))).toThrow(
      /U\+D83D at position 10/,
    );
  });
});

describe("a User-Agent fetch can send still boots, and is sent (#271)", () => {
  let server: Server;
  let baseUrl: string;
  const received: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push(req.headers["user-agent"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "abc", description: null, public: true, html_url: "x", files: {} }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it.each(SENT)("%s", async (_label, code) => {
    // The control: a gate that copied the token's stricter rule would refuse
    // these, and they work today.
    const userAgent = `my-app/1.0${ch(code)}x`;
    expect(readGistsConfigFromEnv({ MCP_GITHUB_GISTS_USER_AGENT: userAgent }).userAgent).toBe(userAgent);
    const client = new GistsClient({ cfg: cfgWith(userAgent, baseUrl) });
    const before = received.length;
    await expect(client.getGist("abc")).resolves.toMatchObject({ id: "abc" });
    expect(received.length).toBe(before + 1);
  });
});
