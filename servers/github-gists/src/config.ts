/**
 * Parses the github-gists server's environment config.
 *
 * `GITHUB_TOKEN` — fine-scoped PAT (classic) or a fine-grained PAT
 * with the `gist` scope. Optional for reading public gists; required
 * for `update_gist_file`. The token value is never embedded in any
 * user-visible error message (D-007); only its presence is signaled.
 *
 * `MCP_GITHUB_GISTS_BASE_URL` — override for the GitHub REST API base.
 * Defaults to `https://api.github.com`. Useful for pointing the server
 * at GitHub Enterprise Server (`https://github.example.com/api/v3`)
 * or at a recorded-fixture server in tests.
 *
 * `MCP_GITHUB_GISTS_USER_AGENT` — UA string sent on every request.
 * Defaults to `mcp-cookbook-github-gists/0.1.0`. GitHub rejects
 * requests without a UA header, so we always send one.
 *
 * `MCP_GITHUB_GISTS_TIMEOUT_MS` — per-call request timeout. Defaults
 * to 10_000 ms. Tools surface a clear `request_timed_out` error rather
 * than hanging the MCP client.
 */

export interface GistsConfig {
  /**
   * The raw token. Always treat as secret: never log, never put in
   * error messages, never echo in tool responses. Use `hasToken()` to
   * tell callers whether auth is configured without leaking the value.
   */
  token: string | null;
  baseUrl: string;
  userAgent: string;
  timeoutMs: number;
}

const DEFAULT_BASE = "https://api.github.com";
const DEFAULT_UA = "mcp-cookbook-github-gists/0.1.0";
const DEFAULT_TIMEOUT_MS = 10_000;

export function readGistsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GistsConfig {
  const rawToken = env.GITHUB_TOKEN ?? "";
  const token = rawToken.trim().length > 0 ? rawToken.trim() : null;

  const baseUrl = (env.MCP_GITHUB_GISTS_BASE_URL ?? DEFAULT_BASE).trim() || DEFAULT_BASE;
  // Refuse a base URL that obviously isn't a URL — a `gh://` or empty
  // value would silently send requests to a wrong endpoint. Defense in
  // depth: configuration errors should fail loud at boot.
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(
      `MCP_GITHUB_GISTS_BASE_URL must start with http:// or https://; got ${JSON.stringify(baseUrl)}`,
    );
  }
  // Strip a trailing slash so the request builder can always join with `/gists/<id>`.
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  const userAgent = (env.MCP_GITHUB_GISTS_USER_AGENT ?? "").trim() || DEFAULT_UA;

  const timeoutRaw = env.MCP_GITHUB_GISTS_TIMEOUT_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== undefined && timeoutRaw !== "") {
    const parsed = Number(timeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(
        `MCP_GITHUB_GISTS_TIMEOUT_MS must be a positive integer; got ${JSON.stringify(timeoutRaw)}`,
      );
    }
    timeoutMs = parsed;
  }

  return { token, baseUrl: normalizedBase, userAgent, timeoutMs };
}

export function hasToken(cfg: GistsConfig): boolean {
  return cfg.token !== null;
}

/**
 * Validate a `GistsConfig` at the programmatic entry of `GithubClient`
 * so the security- and behavior-relevant fields cannot be silently
 * degenerate when a caller (test, custom driver, future cross-server
 * import per D-002's "explicit cross-server import" carve-out) builds
 * one directly rather than through `readGistsConfigFromEnv`.
 *
 * Without this guard:
 *   - `timeoutMs = 0` produces an `AbortSignal.timeout(0)` that aborts
 *     every request on the next tick — silent degeneracy that makes
 *     every tool call fail with a timeout before the network round-
 *     trip even starts.
 *   - `baseUrl = ""` or a non-`http(s)://` string would silently send
 *     requests to relative paths — the env path validates this; the
 *     programmatic path does not.
 *   - `userAgent = ""` reaches GitHub with an empty UA header; GitHub
 *     rejects no-UA requests outright.
 *   - `token = ""` constructs the truthy `token !== null` path (looks
 *     like "auth configured" to `hasToken`) but actually sends an
 *     empty bearer header — silently presents as unauthenticated to
 *     the API while signaling auth-configured to callers.
 *
 * Mirrors the portfolio's contract-tightening sweep applied to this
 * repo's `internal-tools-bridge` `BridgeConfig` (#4, D-009).
 */
export function validateGistsConfig(cfg: GistsConfig): void {
  if (typeof cfg.baseUrl !== "string" || cfg.baseUrl.length === 0) {
    throw new Error(
      `GistsConfig.baseUrl must be a non-empty string; got ${JSON.stringify(cfg.baseUrl)}`,
    );
  }
  if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    throw new Error(
      `GistsConfig.baseUrl must start with http:// or https://; got ${JSON.stringify(cfg.baseUrl)}`,
    );
  }
  if (typeof cfg.userAgent !== "string" || cfg.userAgent.length === 0) {
    throw new Error(
      `GistsConfig.userAgent must be a non-empty string; got ${JSON.stringify(cfg.userAgent)}`,
    );
  }
  if (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 1) {
    // `RangeError` matches the prior numeric-field validation shape on
    // this server's `GistsClient` constructor (#34) — existing tests
    // assert RangeError for negative timeoutMs and that test bar is
    // preserved here as the consolidated gate covers more fields.
    throw new RangeError(
      `GistsConfig.timeoutMs must be an integer >= 1; got ${cfg.timeoutMs}`,
    );
  }
  if (cfg.token !== null) {
    if (typeof cfg.token !== "string" || cfg.token.length === 0) {
      throw new Error(
        `GistsConfig.token must be null or a non-empty string; got ${JSON.stringify(cfg.token)}. ` +
          `An empty token would silently present as unauthenticated to the API while signaling ` +
          `auth-configured to hasToken() — set null explicitly to opt out of auth.`,
      );
    }
  }
}
