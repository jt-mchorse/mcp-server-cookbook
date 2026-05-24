import { describe, expect, it } from "vitest";

import type { GistsConfig } from "../src/config.js";
import {
  type FetchLike,
  GistsClient,
  GithubApiError,
  RequestTimeoutError,
  TokenRequiredError,
} from "../src/client.js";

function baseCfg(overrides: Partial<GistsConfig> = {}): GistsConfig {
  return {
    token: null,
    baseUrl: "https://api.github.test",
    userAgent: "ua/0.1",
    timeoutMs: 10_000,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function recordingFetch(
  response: {
    status: number;
    ok: boolean;
    jsonBody?: unknown;
    textBody?: string;
    responseHeaders?: Record<string, string>;
  },
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  // HeadersLike fake: case-insensitive lookup, matches the contract
  // native fetch's `Headers` honors per WHATWG spec.
  const lookup = new Map<string, string>(
    Object.entries(response.responseHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const headers = {
    get(name: string): string | null {
      return lookup.get(name.toLowerCase()) ?? null;
    },
  };
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    return {
      status: response.status,
      ok: response.ok,
      headers,
      async text() {
        return response.textBody ?? (response.jsonBody !== undefined ? JSON.stringify(response.jsonBody) : "");
      },
      async json() {
        if (response.jsonBody !== undefined) return response.jsonBody;
        throw new Error("no json body");
      },
    };
  };
  return { fetch, calls };
}

// ---------------- getGist ----------------

describe("GistsClient.getGist", () => {
  it("builds the correct GET request and headers without a token", async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      ok: true,
      jsonBody: { id: "abc", description: null, public: true, html_url: "u", files: {} },
    });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    await client.getGist("abc");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.test/gists/abc");
    expect(calls[0].headers.Accept).toBe("application/vnd.github+json");
    expect(calls[0].headers["User-Agent"]).toBe("ua/0.1");
    expect(calls[0].headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[0].headers["Content-Type"]).toBeUndefined();
    expect(calls[0].body).toBeUndefined();
  });

  it("attaches a Bearer token when configured", async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      ok: true,
      jsonBody: { id: "abc", description: null, public: true, html_url: "u", files: {} },
    });
    const client = new GistsClient({ cfg: baseCfg({ token: "ghp_secret_value" }), fetch });
    await client.getGist("abc");
    expect(calls[0].headers.Authorization).toBe("Bearer ghp_secret_value");
  });

  it("URL-encodes the gist id", async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      ok: true,
      jsonBody: { id: "x/y", description: null, public: false, html_url: "u", files: {} },
    });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    await client.getGist("x/y");
    expect(calls[0].url).toBe("https://api.github.test/gists/x%2Fy");
  });

  it("rejects an empty or whitespace gist id", async () => {
    const { fetch } = recordingFetch({ status: 200, ok: true, jsonBody: {} });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    await expect(client.getGist("")).rejects.toThrow(/non-empty/);
    await expect(client.getGist("   ")).rejects.toThrow(/non-empty/);
  });

  it("turns a 404 into a GithubApiError with no token in the message", async () => {
    const { fetch } = recordingFetch({
      status: 404,
      ok: false,
      jsonBody: { message: "Not Found", documentation_url: "https://docs/" },
    });
    const client = new GistsClient({ cfg: baseCfg({ token: "ghp_secret_value" }), fetch });
    await expect(client.getGist("nope")).rejects.toMatchObject({
      name: "GithubApiError",
      status: 404,
    });
    try {
      await client.getGist("nope");
    } catch (e) {
      expect(e).toBeInstanceOf(GithubApiError);
      expect((e as Error).message).not.toContain("ghp_secret_value");
      expect((e as Error).message).toContain("Not Found");
      expect((e as Error).message).toContain("404");
      expect((e as Error).message).toContain("/gists/nope");
    }
  });

  it("falls back to a truncated text body when the error response isn't JSON", async () => {
    const { fetch } = recordingFetch({
      status: 502,
      ok: false,
      textBody: "x".repeat(500),
    });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    try {
      await client.getGist("abc");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GithubApiError);
      // Capped to ~200 chars plus the ellipsis.
      expect((e as Error).message.length).toBeLessThan(280);
    }
  });
});

// ---------------- updateGistFile ----------------

describe("GistsClient.updateGistFile", () => {
  it("refuses to call without a token", async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      ok: true,
      jsonBody: { id: "abc", description: null, public: false, html_url: "u", files: {} },
    });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    await expect(
      client.updateGistFile({ gistId: "abc", filename: "f.md", content: "hi" }),
    ).rejects.toBeInstanceOf(TokenRequiredError);
    expect(calls).toHaveLength(0); // never sent a request
  });

  it("builds the correct PATCH request body", async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      ok: true,
      jsonBody: { id: "abc", description: "new desc", public: false, html_url: "u", files: {} },
    });
    const client = new GistsClient({ cfg: baseCfg({ token: "tok" }), fetch });
    await client.updateGistFile({
      gistId: "abc",
      filename: "notes.md",
      content: "hello world",
      description: "new desc",
    });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("https://api.github.test/gists/abc");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(calls[0].body).toBeDefined();
    const parsed = JSON.parse(calls[0].body as string);
    expect(parsed).toEqual({
      files: { "notes.md": { content: "hello world" } },
      description: "new desc",
    });
  });

  it("omits description from the payload when not provided", async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      ok: true,
      jsonBody: { id: "abc", description: null, public: false, html_url: "u", files: {} },
    });
    const client = new GistsClient({ cfg: baseCfg({ token: "tok" }), fetch });
    await client.updateGistFile({ gistId: "abc", filename: "notes.md", content: "hi" });
    const parsed = JSON.parse(calls[0].body as string);
    expect(parsed).toEqual({ files: { "notes.md": { content: "hi" } } });
    expect(parsed.description).toBeUndefined();
  });

  it("validates required arguments", async () => {
    const { fetch } = recordingFetch({ status: 200, ok: true, jsonBody: {} });
    const client = new GistsClient({ cfg: baseCfg({ token: "tok" }), fetch });
    await expect(
      client.updateGistFile({ gistId: "", filename: "f", content: "x" }),
    ).rejects.toThrow(/gist_id/);
    await expect(
      client.updateGistFile({ gistId: "a", filename: "", content: "x" }),
    ).rejects.toThrow(/filename/);
    await expect(
      // @ts-expect-error intentionally wrong type
      client.updateGistFile({ gistId: "a", filename: "f", content: 12 }),
    ).rejects.toThrow(/content/);
  });

  it("does not include the token in the error message on 401", async () => {
    const { fetch } = recordingFetch({
      status: 401,
      ok: false,
      jsonBody: { message: "Bad credentials" },
    });
    const client = new GistsClient({ cfg: baseCfg({ token: "ghp_secret_value" }), fetch });
    try {
      await client.updateGistFile({ gistId: "abc", filename: "f", content: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GithubApiError);
      expect((e as Error).message).not.toContain("ghp_secret_value");
      expect((e as Error).message).toContain("401");
      expect((e as Error).message).toContain("Bad credentials");
    }
  });
});

// ---------------- timeout ----------------

describe("GistsClient timeout handling", () => {
  it("converts an AbortError into RequestTimeoutError", async () => {
    const fetch: FetchLike = async () => {
      const err: Error & { name?: string } = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const client = new GistsClient({ cfg: baseCfg({ timeoutMs: 50 }), fetch });
    await expect(client.getGist("abc")).rejects.toBeInstanceOf(RequestTimeoutError);
  });
});

// ---------------- diagnostic headers on GithubApiError (issue #28) ----------------

describe("GithubApiError diagnostic headers", () => {
  it("populates requestId from X-GitHub-Request-Id on a 404", async () => {
    const { fetch } = recordingFetch({
      status: 404,
      ok: false,
      jsonBody: { message: "Not Found" },
      responseHeaders: { "X-GitHub-Request-Id": "ABCD:1234:5678:9012:34567890" },
    });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    try {
      await client.getGist("missing");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GithubApiError);
      const err = e as GithubApiError;
      expect(err.requestId).toBe("ABCD:1234:5678:9012:34567890");
      // The other diagnostics stay null when their headers are absent.
      expect(err.rateLimitRemaining).toBeNull();
      expect(err.rateLimitResetEpoch).toBeNull();
      expect(err.retryAfterSeconds).toBeNull();
    }
  });

  it("populates rate-limit triad on a 403 'rate limit exceeded'", async () => {
    const { fetch } = recordingFetch({
      status: 403,
      ok: false,
      jsonBody: { message: "API rate limit exceeded for user ID 1." },
      responseHeaders: {
        "X-GitHub-Request-Id": "RATE:1",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1717420000",
      },
    });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    try {
      await client.getGist("abc");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GithubApiError);
      const err = e as GithubApiError;
      expect(err.requestId).toBe("RATE:1");
      expect(err.rateLimitRemaining).toBe(0);
      expect(err.rateLimitResetEpoch).toBe(1717420000);
      expect(err.retryAfterSeconds).toBeNull();
    }
  });

  it("populates retryAfterSeconds from Retry-After on a 429 secondary rate limit", async () => {
    const { fetch } = recordingFetch({
      status: 429,
      ok: false,
      jsonBody: { message: "You have exceeded a secondary rate limit." },
      responseHeaders: {
        "X-GitHub-Request-Id": "SRL:1",
        "Retry-After": "60",
      },
    });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    try {
      await client.getGist("abc");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GithubApiError);
      const err = e as GithubApiError;
      expect(err.retryAfterSeconds).toBe(60);
      expect(err.requestId).toBe("SRL:1");
    }
  });

  it("leaves all four fields null and keeps the existing message on a 500 with no diagnostic headers (regression)", async () => {
    const { fetch } = recordingFetch({
      status: 500,
      ok: false,
      textBody: "Internal Server Error",
      responseHeaders: {},
    });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    try {
      await client.getGist("abc");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GithubApiError);
      const err = e as GithubApiError;
      expect(err.requestId).toBeNull();
      expect(err.rateLimitRemaining).toBeNull();
      expect(err.rateLimitResetEpoch).toBeNull();
      expect(err.retryAfterSeconds).toBeNull();
      // Message format unchanged.
      expect(err.message).toMatch(/^github_api_error \(500 GET \/gists\/abc\):/);
      // And the secret/private-context redaction posture is preserved.
      expect(err.message).not.toContain("Internal Server Error".slice(0, 0) + "Bearer");
    }
  });

  it("does not include header values in the error message itself (D-007 grep-able log)", async () => {
    const { fetch } = recordingFetch({
      status: 403,
      ok: false,
      jsonBody: { message: "Forbidden" },
      responseHeaders: {
        "X-GitHub-Request-Id": "PRIVATE_REQUEST_ID_VALUE",
        "X-RateLimit-Remaining": "0",
      },
    });
    const client = new GistsClient({ cfg: baseCfg(), fetch });
    try {
      await client.getGist("abc");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).not.toContain("PRIVATE_REQUEST_ID_VALUE");
    }
  });
});
