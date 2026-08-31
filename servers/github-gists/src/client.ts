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

import { type GistsConfig, validateGistsConfig } from "./config.js";

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

/**
 * Parse an integer response header, or `null` when it is absent or not a plain
 * base-10 integer (#154).
 *
 * ### The grammar, shared; the contract, deliberately not
 *
 * `Number.parseInt(raw, 10)` stops at the first character it cannot consume and
 * returns what it has. Run #152's table against it:
 *
 *     "1000"                ->  1000    ok
 *     "5s"                  ->  5
 *     "1e3"                 ->  1
 *     "1_000"               ->  1
 *     "10.9"                ->  10
 *     "0x10"                ->  0
 *     "9007199254740993"    ->  9007199254740992   (silently one lower)
 *     "abc" / ""            ->  null    ok
 *
 * The gate below is the one #152 settled for this cookbook's numeric
 * *environment* variables — trim, `^[+-]?\d+$`, bound the magnitude with
 * `BigInt` before `Number` can lose precision — and the same gate is right
 * here, because "what counts as an integer" is not where these two sites
 * differ.
 *
 * What they differ on is what an unreadable value *means*. An env var is
 * operator config: a malformed one should refuse the boot, so those parsers
 * throw. A response header is **remote input on an error path**, and an
 * observability helper must not be the thing that fails a request that
 * otherwise worked — so this one returns `null` and never throws. `BigInt()`
 * is called only inside the gate, after the regex has proved the string is
 * digits, so it cannot be the exception that escapes.
 *
 * ### Why `0x10 -> 0` was the row that mattered
 *
 * These three fields are diagnostics: `extractGithubDiagnostics` fills them on
 * `GithubApiError` and `describeGithubApiError` renders the non-null ones into
 * the client-visible line. Nothing retries or backs off on them. So the old
 * behaviour did not change what the client *did* — it changed what the client
 * was *told*, and `rate-limit-remaining: 0` reads as "you are rate limited",
 * which is the most consequential reading of a header the parser could not
 * actually read. A wrong diagnostic on an error path is worse than an absent
 * one, because it is the line someone debugs from.
 *
 * ### `Retry-After`'s HTTP-date form is unsupported, by decision
 *
 * RFC 9110 allows `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` as well as a
 * delay in seconds. That maps to `null` here, and it did before — but by
 * accident, because `parseInt` returned `NaN`. It is now by choice: converting
 * a date to `retryAfterSeconds` needs a clock, which makes a pure parser
 * time-dependent and untestable without injecting one, and it buys nothing
 * while no caller consumes the field for backoff. **If one ever does, the date
 * form has to be revisited before that lands**, or a server answering with a
 * date will look like a server that sent no `Retry-After` at all.
 *
 * ### The sign is accepted
 *
 * `+5` and `-1` parse, because the grammar is shared and this is a diagnostic:
 * a well-formed but nonsensical number is reported as-is rather than hidden.
 * A negative `X-RateLimit-Remaining` is visibly wrong to whoever reads the
 * line, where a silently-null one is not.
 *
 * ### Not in `check-numeric-env-grammar.mjs`'s population, on purpose
 *
 * That checker discovers files that coerce a value which came from the
 * *environment*; this one reads headers, so it is out of scope by the
 * predicate rather than by an exemption. It is nonetheless written in the
 * spelling that checker recognizes — `BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER)`
 * rather than an equivalent rearrangement — so that if this file ever does
 * acquire an environment read, it joins the population already passing instead
 * of failing on a cosmetic difference.
 */
function _parseIntHeader(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const withinSafeRange =
    BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER) &&
    BigInt(trimmed) >= -BigInt(Number.MAX_SAFE_INTEGER);
  if (!withinSafeRange) return null;
  return Number(trimmed);
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
    // Programmatic-entry validation (#34 + #44). The env-reading layer
    // at `config.ts` `readGistsConfigFromEnv` already guards the
    // standard path; anyone constructing programmatically — test
    // setups, embedding apps, alternate config sources — needs the
    // same loud-failure surface across every security- and behavior-
    // relevant field. #44 broadened the per-field coverage from the
    // single `timeoutMs` check landed in #34 to the four-field
    // contract on `GistsConfig` (baseUrl, userAgent, timeoutMs, token).
    validateGistsConfig(deps.cfg);
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
    // typeof guard mirrors getGist (which type-checks gistId) and the content
    // check below: a present-but-non-string arg (the MCP handler casts
    // `a.gist_id as string` with no runtime validation, and the SDK doesn't
    // enforce inputSchema types) is truthy, so without this it skips the guard
    // and `.trim()` throws a raw TypeError instead of this clean message (#117).
    if (!args.gistId || typeof args.gistId !== "string" || args.gistId.trim().length === 0) {
      throw new Error("gist_id must be a non-empty string");
    }
    if (!args.filename || typeof args.filename !== "string" || args.filename.trim().length === 0) {
      throw new Error("filename must be a non-empty string");
    }
    if (typeof args.content !== "string") {
      throw new Error("content must be a string");
    }
    const endpoint = `/gists/${encodeURIComponent(args.gistId.trim())}`;
    const payload: Record<string, unknown> = {
      files: {
        // Use the trimmed filename as the key, matching the validation above
        // (which rejects whitespace-only names via `.trim()`) and the gistId
        // treatment. The raw value sent GitHub a key like "  notes.md  ",
        // targeting a whitespace-named file instead of the intended one.
        [args.filename.trim()]: { content: args.content },
      },
    };
    // `description` is the optional string sibling of gist_id/filename/content:
    // the MCP handler casts `a.description as string | undefined` with no runtime
    // validation, so a non-string can arrive here. Without this guard it was
    // forwarded into the PATCH payload unvalidated (a wasted authenticated call +
    // a remote 422 instead of a clean local message). Allow the undefined case;
    // reject a present-but-non-string value, matching the #117 typeof contract.
    if (args.description !== undefined && typeof args.description !== "string") {
      throw new Error("description must be a string when provided");
    }
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
  private async reasonFromResponse(res: { status: number; text(): Promise<string> }): Promise<string> {
    // Read the body exactly once. A real WHATWG `Response` body is a
    // single-use stream, so the old `await res.json()` then `await res.text()`
    // sequence threw `TypeError: Body is unusable` on the second read for any
    // non-JSON error body — swallowing the server's message and returning a
    // bare `status N`. Read text first, then try to parse it as JSON for
    // GitHub's `message` convention; fall back to the same text otherwise (#58).
    let text: string;
    try {
      text = await res.text();
    } catch {
      return `status ${res.status}`;
    }
    // Pick the reason — GitHub's `message` field when present, else the raw text
    // — then cap ONCE below. The cap must cover BOTH branches (#64): a
    // misconfigured (or hostile) upstream can return a multi-megabyte JSON
    // `message` just as easily as a huge HTML body, and an uncapped `message`
    // would flow verbatim into the GithubApiError, the tool result, and logs —
    // exactly the "unredacted response chunk" D-007 says errors must not carry.
    let reason = text;
    try {
      const body = JSON.parse(text) as { message?: unknown };
      if (typeof body?.message === "string" && body.message.length > 0) {
        reason = body.message;
      }
    } catch {
      // body wasn't JSON; keep the raw text as the reason
    }
    if (reason.length === 0) {
      return `status ${res.status}`;
    }
    // Cap the length so a misconfigured endpoint can't dump megabytes through
    // our errors — applied to the JSON `message` and the raw-text fallback alike.
    return reason.length > 200 ? reason.slice(0, 200) + "…" : reason;
  }
}
