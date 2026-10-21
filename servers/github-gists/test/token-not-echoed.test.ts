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
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type FetchLike,
  formatGithubApiError,
  GistsClient,
  GithubApiError,
  UpstreamUnreachableError,
} from "../src/client.js";
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

/**
 * An upstream error body that quotes the request's `Authorization` header
 * (#305). Measured on `main`: a header-echoing proxy answering 401 with
 * `{"message": "rejected Authorization: Bearer <token>"}` produced
 * `github_api_error (401 GET /gists/json): rejected Authorization: Bearer
 * ghp_...`, the token in the tool error. #264 redacted the fetch-failure path
 * and `readJson`; the non-2xx reason, also upstream text, was not.
 */
describe("an error body that echoes the token is redacted (#305)", () => {
  type Reply = (auth: string) => { status: number; body: string };

  function echoing(token: string | null, reply: Reply): GistsClient {
    const cfg: GistsConfig = { token, baseUrl: "https://api.github.test", userAgent: "ua/0.1", timeoutMs: 2_000 };
    const fetch: FetchLike = async (_url, init) => {
      const { status, body } = reply(init?.headers?.Authorization ?? "");
      return new Response(body, { status }) as unknown as Awaited<ReturnType<FetchLike>>;
    };
    return new GistsClient({ cfg, fetch });
  }

  async function apiError(p: Promise<unknown>): Promise<{ err: GithubApiError; text: string }> {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    const e = err as GithubApiError;
    return { err: e, text: formatGithubApiError(e) };
  }

  const jsonEcho: Reply = (auth) => ({ status: 401, body: JSON.stringify({ message: `rejected Authorization: ${auth}` }) });

  it("a JSON message on GET", async () => {
    const { err, text } = await apiError(echoing(SECRET, jsonEcho).getGist("abc"));
    expect(text).not.toContain(SECRET);
    expect(err.reason).toBe("rejected Authorization: Bearer [REDACTED]");
  });

  it("a plain-text body on GET", async () => {
    const client = echoing(SECRET, (auth) => ({ status: 400, body: `bad request; headers seen: authorization=${auth}` }));
    const { err, text } = await apiError(client.getGist("abc"));
    expect(text).not.toContain(SECRET);
    expect(err.reason).toBe("bad request; headers seen: authorization=Bearer [REDACTED]");
  });

  it("a JSON message on PATCH", async () => {
    const client = echoing(SECRET, jsonEcho);
    const { err, text } = await apiError(client.updateGistFile({ gistId: "abc", filename: "f.md", content: "hi" }));
    expect(text).not.toContain(SECRET);
    expect(err.reason).toBe("rejected Authorization: Bearer [REDACTED]");
  });

  it("every occurrence, not just the first", async () => {
    const client = echoing(SECRET, (auth) => ({ status: 403, body: `${auth} / ${auth}` }));
    const { err } = await apiError(client.getGist("abc"));
    expect(err.reason).toBe("Bearer [REDACTED] / Bearer [REDACTED]");
  });

  it("a token straddling the 200-unit cap leaves no prefix behind", async () => {
    // The token starts at unit 197, so capping first would keep `ghp`.
    const client = echoing(SECRET, (auth) => ({ status: 401, body: "x".repeat(190) + auth }));
    const { err, text } = await apiError(client.getGist("abc"));
    expect(text).not.toContain("ghp");
    expect(err.reason.startsWith("x".repeat(190) + "Bearer [RE")).toBe(true);
  });

  it("a body without the token, and a client without one, are unchanged (control)", async () => {
    const plain = await apiError(echoing(SECRET, () => ({ status: 404, body: '{"message":"Not Found"}' })).getGist("abc"));
    expect(plain.err.reason).toBe("Not Found");
    const anon = await apiError(echoing(null, jsonEcho).getGist("abc"));
    expect(anon.err.reason).toBe("rejected Authorization: ");
  });
});

/**
 * A token padded at the ends is refused in a built config (#312). Measured on
 * 62644b3 with the real `fetch` against a loopback server echoing
 * `Authorization` in its body and `X-GitHub-Request-Id`: `"<token>"` came back
 * `Bearer [REDACTED]` on both surfaces, `"<token> "` came back as the token on
 * both. `fetch` strips the trailing space before sending, so the echoed token
 * is the trimmed one and the redaction, searching for the padded one, never
 * matched. The env path trims; a built config could not.
 */
describe("a built config cannot hold a token padded at the ends (#312)", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const auth = String(req.headers.authorization ?? "");
      res.writeHead(401, { "content-type": "application/json", "x-github-request-id": auth });
      res.end(JSON.stringify({ message: `bad credentials: ${auth}` }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const cfgFor = (token: string): GistsConfig => ({ token, baseUrl, userAgent: "ua/0.1", timeoutMs: 2_000 });

  /** Every message a caller can see from building a client and calling it once. */
  async function visibleText(token: string): Promise<string> {
    try {
      const client = new GistsClient({ cfg: cfgFor(token) });
      await client.getGist("abc");
      return "";
    } catch (e) {
      return e instanceof GithubApiError ? formatGithubApiError(e) : (e as Error).message;
    }
  }

  const PADDED: Array<[string, string]> = [
    ["a trailing space", `${SECRET} `],
    ["a leading space", ` ${SECRET}`],
    ["a trailing no-break space", `${SECRET}${ch(0xa0)}`],
  ];

  it.each(PADDED)("refuses %s, without quoting it", (_label, token) => {
    let message = "";
    try {
      validateGistsConfig(cfgFor(token));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/GistsConfig\.token has leading or trailing whitespace/);
    expect(message).not.toContain(SECRET);
  });

  it("refuses a whitespace-only token, which would redact every space in an error", () => {
    expect(() => validateGistsConfig(cfgFor("   "))).toThrow(/leading or trailing whitespace/);
  });

  it("an echoing server never gets the token into the error, end to end", async () => {
    const text = await visibleText(`${SECRET} `);
    expect(text).not.toContain(SECRET);
    expect(text).toMatch(/leading or trailing whitespace/);
  });

  it("a clean token is still sent and redacted from body and request id (control)", async () => {
    const text = await visibleText(SECRET);
    expect(text).toBe(
      "github_api_error (401 GET /gists/abc): bad credentials: Bearer [REDACTED] | request-id=Bearer [REDACTED]",
    );
  });

  it("a space inside the token is not padding and is accepted (control)", () => {
    expect(() => validateGistsConfig(cfgFor("ghp_a b"))).not.toThrow();
  });

  it("the env path still trims a padded token rather than refusing it (control)", () => {
    expect(readGistsConfigFromEnv({ GITHUB_TOKEN: `${SECRET} ` }).token).toBe(SECRET);
  });
});
