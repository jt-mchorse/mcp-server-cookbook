/**
 * A `timeoutMs` can be too large to work as a timeout.
 *
 * Node's `setTimeout` clamps any delay above `2**31 - 1` to 1 ms, so a
 * deliberately-generous timeout becomes an immediate one: the abort deadline
 * fires before the request leaves. That is the same harm `validateGistsConfig`
 * already rejects `timeoutMs = 0` for — its docstring says such a value "aborts
 * every request on the next tick ... makes every tool call fail with a timeout
 * before the network round-trip even starts". Only the lower bound was closed
 * (#143).
 *
 * Reachability runs through the ordinary env grammar rather than a contrived
 * value: `Number("1e10")` is 10000000000 and `Number.isInteger` of it is true,
 * so scientific notation passed every pre-existing check.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_TIMEOUT_MS,
  readGistsConfigFromEnv,
  validateGistsConfig,
} from "../src/config.js";

function envWith(timeout: string): NodeJS.ProcessEnv {
  return { MCP_GITHUB_GISTS_TIMEOUT_MS: timeout } as NodeJS.ProcessEnv;
}

function cfgWith(timeoutMs: number) {
  return {
    token: null,
    baseUrl: "https://api.github.com",
    userAgent: "test-ua",
    timeoutMs,
  };
}

describe("MAX_TIMEOUT_MS is the platform clamp, not a policy number", () => {
  it("is exactly 2**31 - 1", () => {
    expect(MAX_TIMEOUT_MS).toBe(2147483647);
  });

  it("setTimeout honours it and clamps one above it", async () => {
    const check = async (delay: number) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), delay);
      const outcome = await Promise.race([
        new Promise<string>((r) => ac.signal.addEventListener("abort", () => r("aborted"))),
        new Promise<string>((r) => setTimeout(() => r("open"), 120)),
      ]);
      clearTimeout(timer);
      return outcome;
    };
    expect(await check(MAX_TIMEOUT_MS)).toBe("open");
    expect(await check(MAX_TIMEOUT_MS + 1)).toBe("aborted");
  }, 20000);
});

describe("env parser", () => {
  it.each(["2147483648", "5000000000", "9007199254740991"])("rejects %s", (raw) => {
    expect(() => readGistsConfigFromEnv(envWith(raw))).toThrow(/2\*\*31 - 1/);
  });

  it("rejects 1e10 — the scientific-notation route that made this reachable", () => {
    // Pin the premise as well as the rejection: this value really does pass
    // `Number.isFinite`, `> 0` and `Number.isInteger`, so the pre-existing
    // checks could never have caught it.
    expect(Number.isInteger(Number("1e10"))).toBe(true);
    expect(() => readGistsConfigFromEnv(envWith("1e10"))).toThrow(/2\*\*31 - 1/);
  });

  it("still accepts the boundary value", () => {
    expect(readGistsConfigFromEnv(envWith("2147483647")).timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("still accepts an ordinary timeout", () => {
    expect(readGistsConfigFromEnv(envWith("30000")).timeoutMs).toBe(30000);
  });

  it("still rejects what it always rejected", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1e400"]) {
      expect(() => readGistsConfigFromEnv(envWith(bad))).toThrow();
    }
  });
});

describe("validateGistsConfig", () => {
  it.each([2 ** 31, 2 ** 32, 5e9, Number.MAX_SAFE_INTEGER])("rejects timeoutMs=%d", (v) => {
    expect(() => validateGistsConfig(cfgWith(v))).toThrow(RangeError);
    expect(() => validateGistsConfig(cfgWith(v))).toThrow(/2\*\*31 - 1/);
  });

  it("still accepts the boundary value", () => {
    expect(() => validateGistsConfig(cfgWith(MAX_TIMEOUT_MS))).not.toThrow();
  });

  it("still accepts an ordinary timeout", () => {
    expect(() => validateGistsConfig(cfgWith(30000))).not.toThrow();
  });

  it("still rejects the lower bound it always did", () => {
    expect(() => validateGistsConfig(cfgWith(0))).toThrow(RangeError);
    expect(() => validateGistsConfig(cfgWith(-1))).toThrow(RangeError);
    expect(() => validateGistsConfig(cfgWith(1.5))).toThrow(RangeError);
  });

  it("the message explains the ceiling rather than just stating it", () => {
    let msg = "";
    try {
      validateGistsConfig(cfgWith(2 ** 31));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/setTimeout/);
    expect(msg).toMatch(/~1ms/);
  });
});
