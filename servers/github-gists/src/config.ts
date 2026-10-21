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

/**
 * Refuse a token an HTTP header cannot carry, without echoing it (#264).
 *
 * The ends are trimmed above, but nothing looked inside. A CR or LF in the
 * middle (a wrapped paste, an escaped newline in a `.env`) made undici reject
 * the header with `Headers.append: "Bearer <token>" is an invalid header
 * value`, and that message reached the client as the tool result: the token,
 * echoed, which D-007 forbids. A header value is Latin-1 without controls, so
 * anything else is refused at boot. The message names the character's code
 * point and position, never the value.
 */
export function assertTokenIsHeaderSafe(token: string | null): void {
  if (token === null) return;
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code > 0xff) {
      throw new Error(
        `GITHUB_TOKEN contains U+${code.toString(16).toUpperCase().padStart(4, "0")} at ` +
          `position ${i}, which an HTTP header cannot carry; the token is not shown; ` +
          `re-copy it as one line`,
      );
    }
  }
}

export function readGistsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GistsConfig {
  const rawToken = env.GITHUB_TOKEN ?? "";
  const token = rawToken.trim().length > 0 ? rawToken.trim() : null;
  assertTokenIsHeaderSafe(token);

  const baseUrl = (env.MCP_GITHUB_GISTS_BASE_URL ?? DEFAULT_BASE).trim() || DEFAULT_BASE;
  // Refuse a base URL that obviously isn't a URL — a `gh://` or empty
  // value would silently send requests to a wrong endpoint. Defense in
  // depth: configuration errors should fail loud at boot.
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(
      `MCP_GITHUB_GISTS_BASE_URL must start with http:// or https://; got ${JSON.stringify(baseUrl)}`,
    );
  }
  assertBaseUrlIsFetchable(baseUrl, "MCP_GITHUB_GISTS_BASE_URL");
  // Strip a trailing slash so the request builder can always join with `/gists/<id>`.
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  // After the strip, so a query, a fragment or a second trailing slash is named
  // under this variable rather than reaching `validateGistsConfig` as
  // `GistsConfig.baseUrl`, a field the operator never set (#316).
  assertBaseUrlJoinsCleanly(normalizedBase, "MCP_GITHUB_GISTS_BASE_URL");

  const userAgent = (env.MCP_GITHUB_GISTS_USER_AGENT ?? "").trim() || DEFAULT_UA;
  assertUserAgentIsHeaderSafe(userAgent, "MCP_GITHUB_GISTS_USER_AGENT");

  const timeoutRaw = env.MCP_GITHUB_GISTS_TIMEOUT_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  // `timeoutRaw !== ""` deliberately, NOT `timeoutRaw.trim() !== ""`. An empty
  // value meaning "use the default" is this variable's documented behaviour and
  // predates #152. Widening that to whitespace-only would silently turn a value
  // that used to fail the boot into the default — the reverse of the bug this
  // issue is about, slipped in as a convenience. A whitespace-only value now
  // falls through to the grammar gate below and is refused loudly, matching
  // `postgres-readonly`.
  if (timeoutRaw !== undefined && timeoutRaw !== "") {
    // `Number()` alone accepts literal forms that are not "a positive
    // integer": `Number("0x10")` is 16 and `Number("1e3")` is 1000, and
    // `Number.isInteger` is true for both, so hex and scientific notation
    // passed every check here. `filesystem-sandbox`'s config names those exact
    // two forms as ones `Number()` wrongly accepts — #98 unified the grammar
    // across its two *ports* and never reached this server (#152). The explicit
    // regex gate is that grammar; the `BigInt` bound stops `Number` losing
    // precision above `MAX_SAFE_INTEGER` before the checks below can see it.
    const trimmed = timeoutRaw.trim();
    const withinSafeRange =
      /^[+-]?\d+$/.test(trimmed) && BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER);
    const parsed = withinSafeRange ? Number(trimmed) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(
        `MCP_GITHUB_GISTS_TIMEOUT_MS must be a positive integer written in plain base-10 ` +
          `digits (no unit suffix, no scientific notation, no separators); ` +
          `got ${JSON.stringify(timeoutRaw)}`,
      );
    }
    // Above the 32-bit timer limit `setTimeout` clamps to 1 ms, so the abort
    // deadline fires before the request leaves — the same "every tool call
    // fails with a timeout before the network round-trip even starts" harm
    // `validateGistsConfig` below already rejects `timeoutMs = 0` for. A lower
    // bound and an upper bound are different classes; only the lower one was
    // closed (#143).
    //
    // Reachable through the ordinary env grammar: `Number("1e10")` is
    // 10000000000 and `Number.isInteger` of it is `true`, so scientific
    // notation passes every check above. #137/#98 deliberately unified *which
    // literal forms* parse across this repo's ports; *which magnitudes are
    // usable* is a separate axis and was never bounded.
    if (parsed > MAX_TIMEOUT_MS) {
      throw new Error(
        `MCP_GITHUB_GISTS_TIMEOUT_MS must be <= ${MAX_TIMEOUT_MS} (2**31 - 1), the largest ` +
          `delay setTimeout honours; above it the abort fires after ~1ms and every request ` +
          `times out immediately; got ${JSON.stringify(timeoutRaw)}`,
      );
    }
    timeoutMs = parsed;
  }

  return { token, baseUrl: normalizedBase, userAgent, timeoutMs };
}

/**
 * Largest delay Node's `setTimeout` honours. Above this it clamps to 1 ms with
 * a `TimeoutOverflowWarning` on stderr, so a deliberately-generous timeout
 * becomes an immediate one (#143).
 *
 * Measured on an abort deadline: `2147483647` was still open after 122 ms,
 * `2147483648` and `1e10` both aborted after ~2 ms. This is the platform's
 * 32-bit timer limit, not a policy number — raising it does not buy a longer
 * timeout, it buys a timeout that fires instantly.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Refuse a base URL `fetch` would reject on every call, without echoing it (#269).
 *
 * The `^https?://` gate above passes `https://user:pass@proxy/api/v3`, the
 * natural way to write basic auth to a GHE proxy. WHATWG `fetch` refuses any
 * URL with credentials, and undici's message, `Request cannot be constructed
 * from a URL that includes credentials: <the whole URL>`, became the
 * `upstream_unreachable` tool result: the password, echoed to the client on
 * every call, which D-007 forbids. The same shape as #264, on the other config
 * value that can hold a secret. A value `new URL()` cannot parse fails every
 * call too (`Failed to parse URL from <url>`), so it is refused here as well.
 * Neither message quotes the value: an unparseable one may still hold a
 * password, and a parseable one names only its host.
 */
export function assertBaseUrlIsFetchable(baseUrl: string, label: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(
      `${label} is not a URL fetch can parse; the value is not shown, as it may carry ` +
        `credentials`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      `${label} must not contain a username or password (fetch refuses such a URL and its ` +
        `error quotes them); the credentials for host ${JSON.stringify(url.host)} are not shown`,
    );
  }
}

/**
 * Refuse a base URL the request builder cannot append `/gists/<id>` to (#316).
 *
 * The client builds every request as `baseUrl + endpoint`, a string join. The
 * env path trims the value and strips one trailing slash, so it always joins;
 * a built config was taken as is. Each shape below booted and then failed every
 * call: a trailing `/` sent `//gists/<id>` (a 404 from GitHub); surrounding
 * whitespace parsed (`new URL` drops it) but `fetch` refused the joined string
 * with `ERR_INVALID_URL`; and a `?` or `#` turned the endpoint into a query or
 * a fragment, so the request went to the API root while the error named
 * `/gists/<id>`, a path never requested, and an `update_gist_file` PATCH went
 * to the root too. #312 refused, rather than repaired, a token padded at the
 * ends; this is the same rule for the base URL. The `?` and `#` test is on the
 * raw string, not on `url.search`/`url.hash`, which are `""` for a bare `?` or
 * `#`. Run after `assertBaseUrlIsFetchable`, so the value has no credentials,
 * but a query can still hold a key, so the message names only the host.
 */
export function assertBaseUrlJoinsCleanly(baseUrl: string, label: string): void {
  let problem: string | null = null;
  if (baseUrl !== baseUrl.trim()) {
    problem = "has leading or trailing whitespace, which would sit between it and the appended " +
      "/gists/<id> in every request";
  } else if (/[?#]/.test(baseUrl)) {
    problem =
      "has a query or fragment (`?` or `#`), so the appended /gists/<id> would not be the " +
      "path requested";
  } else if (baseUrl.endsWith("/")) {
    problem = "ends with `/`, so requests would go to //gists/<id>";
  }
  if (problem === null) return;
  let host = "";
  try {
    host = new URL(baseUrl).host;
  } catch {
    // Unreachable after `assertBaseUrlIsFetchable`; the message still names the field.
  }
  throw new Error(
    `${label} ${problem}; the value is not shown, as a query may carry a key` +
      (host === "" ? "" : `; host ${JSON.stringify(host)}`),
  );
}

/**
 * Refuse a User-Agent `fetch` would refuse on every call (#271).
 *
 * The token's boot gate (#264) left the config's other header value trimmed at
 * the ends only. A CR, LF or NUL inside it, or a character above U+00FF, booted
 * cleanly, and every tool call then failed in undici's `Headers` before any
 * request left, reported as `upstream_unreachable`. The rule here is the one
 * a real `fetch` applies, measured per code point on a loopback request (not
 * on `new Headers()`, which lets SOH and DEL through for undici's request
 * layer to refuse): every C0 control but TAB, DEL, and anything past Latin-1.
 * A tab and `é` are sent, so they still boot. A User-Agent is not a secret, so
 * the message quotes the value, as this file's other non-secret messages do.
 */
export function assertUserAgentIsHeaderSafe(userAgent: string, label: string): void {
  for (let i = 0; i < userAgent.length; i++) {
    const code = userAgent.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f || code > 0xff) {
      throw new Error(
        `${label} contains U+${code.toString(16).toUpperCase().padStart(4, "0")} at position ` +
          `${i}, which an HTTP header cannot carry; got ${JSON.stringify(userAgent)}`,
      );
    }
  }
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
  assertBaseUrlIsFetchable(cfg.baseUrl, "GistsConfig.baseUrl");
  // A built config must already hold what the env path would have produced
  // (#312's rule, applied to the base URL by #316): trimmed, no trailing slash,
  // and no query or fragment for the endpoint to land in. Refused, not repaired.
  assertBaseUrlJoinsCleanly(cfg.baseUrl, "GistsConfig.baseUrl");
  if (typeof cfg.userAgent !== "string" || cfg.userAgent.length === 0) {
    throw new Error(
      `GistsConfig.userAgent must be a non-empty string; got ${JSON.stringify(cfg.userAgent)}`,
    );
  }
  assertUserAgentIsHeaderSafe(cfg.userAgent, "GistsConfig.userAgent");
  if (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 1) {
    // `RangeError` matches the prior numeric-field validation shape on
    // this server's `GistsClient` constructor (#34) — existing tests
    // assert RangeError for negative timeoutMs and that test bar is
    // preserved here as the consolidated gate covers more fields.
    throw new RangeError(
      `GistsConfig.timeoutMs must be an integer >= 1; got ${cfg.timeoutMs}`,
    );
  }
  // Upper half of the same range. The docstring above explains that
  // `timeoutMs = 0` "aborts every request on the next tick — silent degeneracy
  // that makes every tool call fail with a timeout before the network
  // round-trip even starts". A value at or above `2**31` does exactly that, via
  // the `setTimeout` clamp, and nothing rejected it (#143).
  if (cfg.timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `GistsConfig.timeoutMs must be <= ${MAX_TIMEOUT_MS} (2**31 - 1), the largest delay ` +
        `setTimeout honours; above it the abort fires after ~1ms, so every request fails ` +
        `with a timeout before the round-trip starts; got ${cfg.timeoutMs}`,
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
    assertTokenIsHeaderSafe(cfg.token);
    // A token padded at the ends is refused, not trimmed (#312). `fetch` strips
    // a trailing space from the `Authorization` value, so the token sent, and
    // echoed back by a header-echoing proxy, was the trimmed one, while the
    // client redacted the configured, padded one: `split` never matched and the
    // token reached the tool error verbatim. The env path trims; a built config
    // must already hold what it would have produced, so the token configured is
    // the token sent. Refusing matches the gate above, which refuses a trailing
    // LF or TAB rather than repairing it. The message does not quote the value.
    if (cfg.token !== cfg.token.trim()) {
      throw new Error(
        `GistsConfig.token has leading or trailing whitespace, which fetch strips from the ` +
          `header, so the token sent would not be the one redacted from errors; the token is ` +
          `not shown; trim it before building the config`,
      );
    }
  }
}
