/**
 * Thin GitHub Gists REST client.
 *
 * The whole point of this layer is the **redaction posture** (D-007):
 *
 * - The token is read once from config, attached to the `Authorization`
 *   header inside the client, and *never* echoed back to callers in
 *   any error message, tool result, or log statement.
 * - Errors that escape this module carry an HTTP status, the request
 *   path (without query strings that might carry secrets), and a short
 *   server-reported reason — but never the request body, the response
 *   body, or the token. Callers asking for "more detail" never see the
 *   bearer value; the request body is intentionally dropped from the
 *   error context because it can contain content the user supplied.
 *
 * The client takes an injectable `fetch` so tests can drive its
 * request shaping and error paths without making real network calls.
 */

import type { GistsConfig } from "./config.js";

export interface GistFile {
  filename: string;
  type?: string;
  language?: string | null;
  size?: number;
  truncated?: boolean;
  content?: string;
}

export interface Gist {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  files: Record<string, GistFile>;
}

/**
 * Minimal Headers surface needed for diagnostic header extraction.
 * Native fetch's `Response.headers` (`Headers` instance) satisfies this
 * via `.get(name)`; test fakes implement the same.
 */
export interface HeadersLike {
  get(name: string): string | null;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  headers: HeadersLike;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface GithubApiErrorDiagnostics {
  /** `X-GitHub-Request-Id` if present. Load-bearing for GitHub support tickets. */
  requestId: string | null;
  /** `X-RateLimit-Remaining` parsed as int; null when header absent or unparseable. */
  rateLimitRemaining: number | null;
  /** `X-RateLimit-Reset` parsed as unix epoch (seconds); null when absent. */
  rateLimitResetEpoch: number | null;
  /** `Retry-After` in seconds; null when absent. Typically set on 429 secondary rate limit. */
  retryAfterSeconds: number | null;
}

const _EMPTY_DIAG: GithubApiErrorDiagnostics = {
  requestId: null,
  rateLimitRemaining: null,
  rateLimitResetEpoch: null,
  retryAfterSeconds: null,
};

export class GithubApiError extends Error {
  readonly requestId: string | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitResetEpoch: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly reason: string,
    diag: GithubApiErrorDiagnostics = _EMPTY_DIAG,
  ) {
    // Format: `github_api_error (404 GET /gists/abc123): Not Found`. Token
    // never appears here; nor do diagnostic header values — those live on
    // the structured fields below, so log lines stay one-liner and grep-able.
    super(`github_api_error (${status} ${endpoint}): ${reason}`);
    this.name = "GithubApiError";
    this.requestId = diag.requestId;
    this.rateLimitRemaining = diag.rateLimitRemaining;
    this.rateLimitResetEpoch = diag.rateLimitResetEpoch;
    this.retryAfterSeconds = diag.retryAfterSeconds;
  }
}

/**
 * Extract GitHub's diagnostic headers off a response. Missing or
 * unparseable headers leave the corresponding field null — never throw
 * from this path; an observability helper must not break the error path.
 */
export function extractGithubDiagnostics(headers: HeadersLike): GithubApiErrorDiagnostics {
  return {
    requestId: headers.get("X-GitHub-Request-Id"),
    rateLimitRemaining: _parseIntHeader(headers.get("X-RateLimit-Remaining")),
    rateLimitResetEpoch: _parseIntHeader(headers.get("X-RateLimit-Reset")),
    retryAfterSeconds: _parseIntHeader(headers.get("Retry-After")),
  };
}

function _parseIntHeader(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a single-line client-visible message from a `GithubApiError`,
 * appending any non-null diagnostic header captured by
 * `extractGithubDiagnostics` (request-id, rate-limit-remaining,
 * rate-limit-reset-epoch, retry-after-seconds).
 *
 * Without this helper, the rich diagnostic fields populated by #28
 * stay client-side and never reach an MCP consumer — the gap a
 * 429-with-retry-after surfaces under, where the caller sees "too
 * many requests" but not the backoff window.
 *
 * Null fields are omitted so a non-GitHub-API path (or a 5xx with
 * the headers stripped by an upstream proxy) renders the unchanged
 * base message — the back-compat guarantee for callers that already
 * grep `github_api_error (...)` lines verbatim.
 */
export function formatGithubApiError(err: GithubApiError): string {
  const parts: string[] = [];
  if (err.requestId !== null) parts.push(`request-id=${err.requestId}`);
  if (err.rateLimitRemaining !== null) {
    parts.push(`rate-limit-remaining=${err.rateLimitRemaining}`);
  }
  if (err.rateLimitResetEpoch !== null) {
    parts.push(`rate-limit-reset=${err.rateLimitResetEpoch}`);
  }
  if (err.retryAfterSeconds !== null) {
    parts.push(`retry-after-seconds=${err.retryAfterSeconds}`);
  }
  return parts.length === 0 ? err.message : `${err.message} | ${parts.join(" ")}`;
}

export class RequestTimeoutError extends Error {
  constructor(public readonly endpoint: string, public readonly timeoutMs: number) {
    super(`request_timed_out (${endpoint}, ${timeoutMs}ms)`);
    this.name = "RequestTimeoutError";
  }
}

export class TokenRequiredError extends Error {
  constructor(public readonly operation: string) {
    super(`token_required for ${operation} (set GITHUB_TOKEN)`);
    this.name = "TokenRequiredError";
  }
}

export interface GistsClientDeps {
  cfg: GistsConfig;
  fetch?: FetchLike;
}

export class GistsClient {
  private readonly cfg: GistsConfig;
  private readonly fetchImpl: FetchLike;

  constructor(deps: GistsClientDeps) {
    this.cfg = deps.cfg;
    this.fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * GET /gists/{id}
   *
   * Auth is optional (public gists work without a token), but the
   * token is attached when configured so rate limits are higher and
   * private gists owned by the token's user are reachable.
   */
  async getGist(gistId: string): Promise<Gist> {
    if (!gistId || typeof gistId !== "string" || gistId.trim().length === 0) {
      throw new Error("gist_id must be a non-empty string");
    }
    const endpoint = `/gists/${encodeURIComponent(gistId.trim())}`;
    const res = await this.request("GET", endpoint, undefined);
    if (!res.ok) {
      throw new GithubApiError(
        res.status,
        `GET ${endpoint}`,
        await this.reasonFromResponse(res),
        extractGithubDiagnostics(res.headers),
      );
    }
    const body = (await res.json()) as Gist;
    return body;
  }

  /**
   * PATCH /gists/{id} updating one file inside it.
   *
   * Token is **required**. The request body is built here from the
   * caller's arguments, then dropped from any subsequent error
   * context. Callers see the HTTP status and the GitHub-reported
   * reason, not the bytes we sent.
   */
  async updateGistFile(args: {
    gistId: string;
    filename: string;
    content: string;
    description?: string;
  }): Promise<Gist> {
    if (this.cfg.token === null) {
      throw new TokenRequiredError("update_gist_file");
    }
    if (!args.gistId || args.gistId.trim().length === 0) {
      throw new Error("gist_id must be a non-empty string");
    }
    if (!args.filename || args.filename.trim().length === 0) {
      throw new Error("filename must be a non-empty string");
    }
    if (typeof args.content !== "string") {
      throw new Error("content must be a string");
    }
    const endpoint = `/gists/${encodeURIComponent(args.gistId.trim())}`;
    const payload: Record<string, unknown> = {
      files: {
        [args.filename]: { content: args.content },
      },
    };
    if (args.description !== undefined) {
      payload.description = args.description;
    }
    const res = await this.request("PATCH", endpoint, JSON.stringify(payload));
    if (!res.ok) {
      throw new GithubApiError(
        res.status,
        `PATCH ${endpoint}`,
        await this.reasonFromResponse(res),
        extractGithubDiagnostics(res.headers),
      );
    }
    return (await res.json()) as Gist;
  }

  /** Internal request builder. Attaches headers, applies timeout, converts AbortError → RequestTimeoutError. */
  private async request(
    method: string,
    endpoint: string,
    body: string | undefined,
  ): ReturnType<FetchLike> {
    const url = this.cfg.baseUrl + endpoint;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": this.cfg.userAgent,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.cfg.token !== null) {
      headers.Authorization = `Bearer ${this.cfg.token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: ac.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new RequestTimeoutError(`${method} ${endpoint}`, this.cfg.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Extract a one-line reason from a non-ok response. Reads the JSON
   * `message` field when present (GitHub's convention); falls back to
   * the HTTP status text. NEVER includes the request body, the token,
   * or any other secret context.
   */
  private async reasonFromResponse(res: { status: number; text(): Promise<string>; json(): Promise<unknown> }): Promise<string> {
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body?.message === "string" && body.message.length > 0) {
        return body.message;
      }
    } catch {
      // body wasn't JSON; fall through to text
    }
    try {
      const text = await res.text();
      // Some API error pages can be huge HTML; cap the length so a
      // misconfigured endpoint can't dump megabytes through our errors.
      return text.length > 200 ? text.slice(0, 200) + "…" : text;
    } catch {
      return `status ${res.status}`;
    }
  }
}
