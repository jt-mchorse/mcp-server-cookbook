import { describe, expect, it } from "vitest";

import { hasToken, readGistsConfigFromEnv } from "../src/config.js";

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
