/**
 * The token never reaches a tool result, even when it cannot be sent (#264).
 *
 * A `GITHUB_TOKEN` with a CR or LF inside it made undici refuse the header with
 * `Headers.append: "Bearer <token>" is an invalid header value`, and that text
 * became the `upstream_unreachable` tool result, echoing the token, which
 * D-007 forbids. Two layers now: the config refuses a token a header cannot
 * carry, at boot and without quoting it; and the fetch-failure text has the
 * token redacted, for any message that quotes a header.
 */
import { describe, expect, it } from "vitest";

import { type FetchLike, GistsClient, UpstreamUnreachableError } from "../src/client.js";
import { type GistsConfig, readGistsConfigFromEnv, validateGistsConfig } from "../src/config.js";

const SECRET = "ghp_SECRET123";
const ch = (code: number): string => String.fromCharCode(code);

const BAD: Array<[string, string]> = [
  ["LF", `${SECRET}${ch(10)}ghp_x`],
  ["CR", `${SECRET}${ch(13)}x`],
  ["TAB in the middle", `${SECRET}${ch(9)}x`],
  ["NUL", `${SECRET}${ch(0)}x`],
  ["SOH", `${SECRET}${ch(1)}x`],
  ["DEL", `${SECRET}${ch(0x7f)}x`],
  ["U+2028 line separator", `${SECRET}${ch(0x2028)}x`],
  ["a non-Latin-1 letter", `${SECRET}${ch(0x0416)}x`],
];

describe("the config refuses a token a header cannot carry (#264)", () => {
  it.each(BAD)("from the environment: %s", (_label, token) => {
    let message = "";
    try {
      readGistsConfigFromEnv({ GITHUB_TOKEN: token });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/GITHUB_TOKEN contains U\+[0-9A-F]{4} at position \d+/);
    expect(message).not.toContain(SECRET);
  });

  it.each(BAD)("in a built config: %s", (_label, token) => {
    const cfg: GistsConfig = {
      token,
      baseUrl: "https://api.github.test",
      userAgent: "ua/0.1",
      timeoutMs: 2_000,
    };
    expect(() => validateGistsConfig(cfg)).toThrow(/cannot carry/);
  });

  it("still accepts a normal token, trimmed at the ends", () => {
    expect(readGistsConfigFromEnv({ GITHUB_TOKEN: `  ${SECRET}\n` }).token).toBe(SECRET);
  });
});

describe("a fetch failure that quotes the token is redacted (#264)", () => {
  function client(token: string, fetch: FetchLike): GistsClient {
    const cfg: GistsConfig = { token, baseUrl: "https://api.github.test", userAgent: "ua/0.1", timeoutMs: 2_000 };
    return new GistsClient({ cfg, fetch });
  }

  it("names the failure without the token", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError(`Headers.append: "Bearer ${SECRET}" is an invalid header value.`);
    };
    const err = await client(SECRET, fetch).getGist("abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnreachableError);
    const msg = (err as Error).message;
    expect(msg).not.toContain(SECRET);
    expect(msg).toContain("[REDACTED]");
  });

  it("a client cannot even be built around such a token", () => {
    // `GistsClient` validates the config it is handed, so the real fetch is
    // never reached with a token undici would quote back.
    const token = `${SECRET}${ch(10)}ghp_x`;
    let message = "";
    try {
      client(token, globalThis.fetch as never);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/cannot carry/);
    expect(message).not.toContain(SECRET);
  });
});
