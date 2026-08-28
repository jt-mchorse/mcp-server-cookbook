/**
 * `MCP_GITHUB_GISTS_TIMEOUT_MS` accepts a positive integer, and only that (#152).
 *
 * This one was found by running #152's table across *every* server rather than
 * only the one it was filed against. The parser used bare `Number()`, so
 * `Number("0x10")` was 16 and `Number("1e3")` was 1000 — and `Number.isInteger`
 * is true for both, so hex and scientific notation passed every check.
 *
 * `filesystem-sandbox`'s config names those exact two forms as ones `Number()`
 * wrongly accepts. #98 unified the grammar across its two *ports* and never
 * reached this server: the correct answer was already written down in this
 * repo, one directory over.
 */
import { describe, expect, it } from "vitest";

import { readGistsConfigFromEnv } from "../src/config.js";

const BASE = { MCP_GITHUB_GISTS_TOKEN: "ghp_x" } as NodeJS.ProcessEnv;

const REJECTED = [
  "5s",
  "30m",
  "1000ms",
  "5 seconds",
  "1e3",
  "1e10",
  "1_000",
  "10.9",
  "0x10",
  "0o17",
  "abc",
  "  ",
  "9007199254740993",
  "-5",
  "0",
] as const;

describe("MCP_GITHUB_GISTS_TIMEOUT_MS", () => {
  it.each(REJECTED)("rejects %j", (raw) => {
    expect(() =>
      readGistsConfigFromEnv({ ...BASE, MCP_GITHUB_GISTS_TIMEOUT_MS: raw }),
    ).toThrow(/must be a positive integer/);
  });

  it.each([
    ["1000", 1000],
    [" 1000 ", 1000],
    ["+7", 7],
    ["007", 7],
  ])("accepts %j as %i", (raw, expected) => {
    expect(
      readGistsConfigFromEnv({ ...BASE, MCP_GITHUB_GISTS_TIMEOUT_MS: raw as string }).timeoutMs,
    ).toBe(expected);
  });

  it("still enforces the setTimeout clamp from #143", () => {
    // The grammar gate must not displace the magnitude bound: 2**31 is now
    // written in plain digits, passes the grammar, and must still be refused.
    expect(() =>
      readGistsConfigFromEnv({ ...BASE, MCP_GITHUB_GISTS_TIMEOUT_MS: String(2 ** 31) }),
    ).toThrow(/2\*\*31 - 1/);
    expect(
      readGistsConfigFromEnv({ ...BASE, MCP_GITHUB_GISTS_TIMEOUT_MS: String(2 ** 31 - 1) })
        .timeoutMs,
    ).toBe(2 ** 31 - 1);
  });

  it("an unset or empty value takes the default", () => {
    const unset = readGistsConfigFromEnv({ ...BASE });
    expect(unset.timeoutMs).toBeGreaterThan(0);
    expect(readGistsConfigFromEnv({ ...BASE, MCP_GITHUB_GISTS_TIMEOUT_MS: "" }).timeoutMs).toBe(
      unset.timeoutMs,
    );
  });

  it("hex and scientific notation are refused, not silently converted", () => {
    // The two rows this server got wrong, asserted by their own names so a
    // regression is legible rather than just a count.
    for (const [raw, wouldHaveBeen] of [
      ["0x10", 16],
      ["1e3", 1000],
    ] as const) {
      expect(Number(raw)).toBe(wouldHaveBeen); // the value it used to accept
      expect(() =>
        readGistsConfigFromEnv({ ...BASE, MCP_GITHUB_GISTS_TIMEOUT_MS: raw }),
      ).toThrow();
    }
  });
});
