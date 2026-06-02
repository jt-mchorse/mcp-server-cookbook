import { describe, expect, it } from "vitest";

import {
  type GistsConfig,
  hasToken,
  readGistsConfigFromEnv,
  validateGistsConfig,
} from "../src/config.js";

describe("readGistsConfigFromEnv", () => {
  it("treats a missing GITHUB_TOKEN as no token", () => {
    const cfg = readGistsConfigFromEnv({});
    expect(cfg.token).toBeNull();
    expect(hasToken(cfg)).toBe(false);
  });

  it("treats an all-whitespace GITHUB_TOKEN as no token", () => {
    const cfg = readGistsConfigFromEnv({ GITHUB_TOKEN: "   " });
    expect(cfg.token).toBeNull();
    expect(hasToken(cfg)).toBe(false);
  });

  it("trims a real GITHUB_TOKEN value", () => {
    const cfg = readGistsConfigFromEnv({ GITHUB_TOKEN: "  ghp_secret_value  " });
    expect(cfg.token).toBe("ghp_secret_value");
    expect(hasToken(cfg)).toBe(true);
  });

  it("defaults base URL to https://api.github.com (no trailing slash)", () => {
    const cfg = readGistsConfigFromEnv({});
    expect(cfg.baseUrl).toBe("https://api.github.com");
  });

  it("strips a trailing slash from the configured base URL", () => {
    const cfg = readGistsConfigFromEnv({
      MCP_GITHUB_GISTS_BASE_URL: "https://github.example.com/api/v3/",
    });
    expect(cfg.baseUrl).toBe("https://github.example.com/api/v3");
  });

  it("rejects a base URL without http:// or https://", () => {
    expect(() => readGistsConfigFromEnv({ MCP_GITHUB_GISTS_BASE_URL: "api.github.com" })).toThrow(
      /must start with http/,
    );
    expect(() => readGistsConfigFromEnv({ MCP_GITHUB_GISTS_BASE_URL: "ftp://api.github.com" })).toThrow(
      /must start with http/,
    );
  });

  it("defaults the user agent and timeout", () => {
    const cfg = readGistsConfigFromEnv({});
    expect(cfg.userAgent).toBe("mcp-cookbook-github-gists/0.1.0");
    expect(cfg.timeoutMs).toBe(10_000);
  });

  it("honors MCP_GITHUB_GISTS_USER_AGENT and MCP_GITHUB_GISTS_TIMEOUT_MS overrides", () => {
    const cfg = readGistsConfigFromEnv({
      MCP_GITHUB_GISTS_USER_AGENT: "custom-ua/1.2.3",
      MCP_GITHUB_GISTS_TIMEOUT_MS: "3500",
    });
    expect(cfg.userAgent).toBe("custom-ua/1.2.3");
    expect(cfg.timeoutMs).toBe(3500);
  });

  it("rejects non-integer or non-positive timeouts", () => {
    expect(() => readGistsConfigFromEnv({ MCP_GITHUB_GISTS_TIMEOUT_MS: "abc" })).toThrow(
      /positive integer/,
    );
    expect(() => readGistsConfigFromEnv({ MCP_GITHUB_GISTS_TIMEOUT_MS: "-1" })).toThrow(
      /positive integer/,
    );
    expect(() => readGistsConfigFromEnv({ MCP_GITHUB_GISTS_TIMEOUT_MS: "1.5" })).toThrow(
      /positive integer/,
    );
    expect(() => readGistsConfigFromEnv({ MCP_GITHUB_GISTS_TIMEOUT_MS: "0" })).toThrow(
      /positive integer/,
    );
  });
});

// ----------------------------------------------------------------------
// #44: programmatic-entry contract gate on `GistsConfig`. Broadens the
// timeoutMs-only check shipped in #34 to baseUrl + userAgent + token +
// timeoutMs. Mirrors `internal-tools-bridge` `validateConfig` (D-009)
// and the portfolio-wide contract-tightening sweep applied to sister
// `Config` types.
// ----------------------------------------------------------------------

function makeValidConfig(overrides: Partial<GistsConfig> = {}): GistsConfig {
  return {
    token: null,
    baseUrl: "https://api.github.com",
    userAgent: "mcp-cookbook-github-gists/0.1.0",
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe("validateGistsConfig — baseUrl", () => {
  it("accepts http and https", () => {
    expect(() =>
      validateGistsConfig(makeValidConfig({ baseUrl: "http://api.example" })),
    ).not.toThrow();
    expect(() =>
      validateGistsConfig(makeValidConfig({ baseUrl: "https://api.example" })),
    ).not.toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => validateGistsConfig(makeValidConfig({ baseUrl: "" }))).toThrow(
      /baseUrl must be a non-empty string/,
    );
  });

  it("rejects a non-string", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateGistsConfig(makeValidConfig({ baseUrl: 42 as any })),
    ).toThrow(/baseUrl must be a non-empty string/);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() =>
      validateGistsConfig(makeValidConfig({ baseUrl: "ftp://api.example" })),
    ).toThrow(/baseUrl must start with http/);
  });
});

describe("validateGistsConfig — userAgent", () => {
  it("rejects an empty UA (GitHub rejects no-UA requests outright)", () => {
    expect(() => validateGistsConfig(makeValidConfig({ userAgent: "" }))).toThrow(
      /userAgent must be a non-empty string/,
    );
  });

  it("rejects a non-string", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateGistsConfig(makeValidConfig({ userAgent: null as any })),
    ).toThrow(/userAgent must be a non-empty string/);
  });
});

describe("validateGistsConfig — timeoutMs", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s with RangeError", (_label, bad) => {
    expect(() => validateGistsConfig(makeValidConfig({ timeoutMs: bad }))).toThrow(RangeError);
  });

  it("RangeError message preserves the #34 shape", () => {
    expect(() => validateGistsConfig(makeValidConfig({ timeoutMs: -42 }))).toThrow(
      /GistsConfig\.timeoutMs must be an integer >= 1; got -42/,
    );
  });

  it("accepts 1 as the minimum", () => {
    expect(() => validateGistsConfig(makeValidConfig({ timeoutMs: 1 }))).not.toThrow();
  });
});

describe("validateGistsConfig — token", () => {
  it("accepts null (opt out of auth)", () => {
    expect(() => validateGistsConfig(makeValidConfig({ token: null }))).not.toThrow();
  });

  it("accepts a non-empty string", () => {
    expect(() =>
      validateGistsConfig(makeValidConfig({ token: "ghp_secret_value" })),
    ).not.toThrow();
  });

  it("rejects an empty-string token (silent unauth + auth-configured signal)", () => {
    expect(() => validateGistsConfig(makeValidConfig({ token: "" }))).toThrow(
      /token must be null or a non-empty string/,
    );
  });

  it("error message names the security trap", () => {
    // Operators reading this should understand WHY "" is rejected:
    // hasToken() returns true on empty string under the prior shape,
    // so the API call goes out as unauthenticated while the caller
    // thinks auth is configured.
    expect(() => validateGistsConfig(makeValidConfig({ token: "" }))).toThrow(
      /unauthenticated to the API while signaling/,
    );
  });

  it("rejects a non-string non-null token", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateGistsConfig(makeValidConfig({ token: 42 as any })),
    ).toThrow(/token must be null or a non-empty string/);
  });
});

describe("validateGistsConfig — env-loaded config round-trips through the gate", () => {
  // Acceptance regression: a `GistsConfig` produced by
  // `readGistsConfigFromEnv` must satisfy `validateGistsConfig` so
  // existing env-loaded callers don't pay a new throw on the happy path.
  it("default env-loaded config validates clean", () => {
    const cfg = readGistsConfigFromEnv({});
    expect(() => validateGistsConfig(cfg)).not.toThrow();
  });

  it("env-loaded config with full overrides validates clean", () => {
    const cfg = readGistsConfigFromEnv({
      GITHUB_TOKEN: "ghp_secret_value",
      MCP_GITHUB_GISTS_BASE_URL: "https://github.example.com/api/v3",
      MCP_GITHUB_GISTS_USER_AGENT: "custom-ua/1.2.3",
      MCP_GITHUB_GISTS_TIMEOUT_MS: "3500",
    });
    expect(() => validateGistsConfig(cfg)).not.toThrow();
  });
});
