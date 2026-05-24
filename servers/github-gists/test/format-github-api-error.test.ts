import { describe, expect, it } from "vitest";

import { formatGithubApiError, GithubApiError } from "../src/client.js";

/**
 * Tests for `formatGithubApiError` (issue #30): the helper that
 * surfaces the diagnostic headers populated by #28 in the
 * single-line message MCP consumers see.
 *
 * The base `err.message` shape is `github_api_error (<status> <endpoint>): <reason>`
 * (pinned by GithubApiError's constructor). This module asserts the
 * appended diagnostic suffix:
 *
 *   <base> | request-id=X rate-limit-remaining=Y rate-limit-reset=Z retry-after-seconds=W
 *
 * with each `field=value` segment omitted when the underlying field is
 * null. When all four fields are null the base message is returned
 * verbatim — the back-compat guarantee for proxies that strip the
 * headers and for non-GitHub paths reusing the formatter.
 */
describe("formatGithubApiError", () => {
  function makeError(diag: {
    requestId?: string | null;
    rateLimitRemaining?: number | null;
    rateLimitResetEpoch?: number | null;
    retryAfterSeconds?: number | null;
  }): GithubApiError {
    return new GithubApiError(404, "GET /gists/abc123", "Not Found", {
      requestId: diag.requestId ?? null,
      rateLimitRemaining: diag.rateLimitRemaining ?? null,
      rateLimitResetEpoch: diag.rateLimitResetEpoch ?? null,
      retryAfterSeconds: diag.retryAfterSeconds ?? null,
    });
  }

  it("returns the unchanged base message when every diagnostic field is null", () => {
    const err = makeError({});
    const msg = formatGithubApiError(err);
    expect(msg).toBe("github_api_error (404 GET /gists/abc123): Not Found");
    // No pipe, no `field=null`, no trailing whitespace.
    expect(msg.includes("|")).toBe(false);
    expect(msg.includes("null")).toBe(false);
  });

  it("appends all four fields when populated, in the documented order", () => {
    const err = makeError({
      requestId: "ABCD:1234:5678:9012:34567890",
      rateLimitRemaining: 0,
      rateLimitResetEpoch: 1_717_420_000,
      retryAfterSeconds: 60,
    });
    const msg = formatGithubApiError(err);
    expect(msg).toBe(
      "github_api_error (404 GET /gists/abc123): Not Found" +
        " | request-id=ABCD:1234:5678:9012:34567890" +
        " rate-limit-remaining=0" +
        " rate-limit-reset=1717420000" +
        " retry-after-seconds=60",
    );
  });

  it("includes only the populated fields when some headers are missing", () => {
    const err = makeError({
      requestId: "REQ:42",
      // rateLimitRemaining intentionally null (proxy stripped it)
      rateLimitResetEpoch: 1_717_420_000,
      // retryAfterSeconds intentionally null (only set on 429)
    });
    const msg = formatGithubApiError(err);
    expect(msg).toBe(
      "github_api_error (404 GET /gists/abc123): Not Found" +
        " | request-id=REQ:42 rate-limit-reset=1717420000",
    );
    // Confirm no `null` literal leaked into the line.
    expect(msg.includes("null")).toBe(false);
    expect(msg.includes("rate-limit-remaining=")).toBe(false);
    expect(msg.includes("retry-after-seconds=")).toBe(false);
  });

  it("treats rate-limit-remaining=0 as present, not as falsy-and-skipped", () => {
    // Sanity check: `0` is the load-bearing case (you're at the cap).
    // The implementation must use `!== null` checks, not truthiness.
    const err = makeError({ rateLimitRemaining: 0 });
    const msg = formatGithubApiError(err);
    expect(msg).toBe(
      "github_api_error (404 GET /gists/abc123): Not Found" +
        " | rate-limit-remaining=0",
    );
  });

  it("does not leak the GITHUB_TOKEN value through the diagnostic suffix", () => {
    // The diagnostic fields never contain the token (extractGithubDiagnostics
    // reads request-id/rate-limit headers only), but pin the invariant so
    // a future field addition can't break it silently.
    const err = makeError({
      requestId: "REQ:42",
      rateLimitRemaining: 42,
    });
    const msg = formatGithubApiError(err);
    expect(msg.toLowerCase().includes("ghp_")).toBe(false);
    expect(msg.toLowerCase().includes("token=")).toBe(false);
    expect(msg.toLowerCase().includes("authorization")).toBe(false);
  });
});
