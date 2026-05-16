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

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export class GithubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly reason: string,
  ) {
    // Format: `github_api_error (404 GET /gists/abc123): Not Found`. Token never appears here.
    super(`github_api_error (${status} ${endpoint}): ${reason}`);
    this.name = "GithubApiError";
  }
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
      throw new GithubApiError(res.status, `GET ${endpoint}`, await this.reasonFromResponse(res));
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
      throw new GithubApiError(res.status, `PATCH ${endpoint}`, await this.reasonFromResponse(res));
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
