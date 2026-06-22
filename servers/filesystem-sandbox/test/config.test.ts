import { describe, expect, it } from "vitest";
import { readSandboxConfigFromEnv } from "../src/config.js";

describe("readSandboxConfigFromEnv", () => {
  it("refuses to start with no allow-list", () => {
    expect(() => readSandboxConfigFromEnv({})).toThrow(/MCP_FS_SANDBOX_ALLOWLIST is required/);
  });

  it("refuses to start with an empty allow-list", () => {
    expect(() => readSandboxConfigFromEnv({ MCP_FS_SANDBOX_ALLOWLIST: "   " })).toThrow(
      /MCP_FS_SANDBOX_ALLOWLIST is required/,
    );
  });

  it("parses a single absolute root", () => {
    const cfg = readSandboxConfigFromEnv({ MCP_FS_SANDBOX_ALLOWLIST: "/tmp/sandbox" });
    expect(cfg.allowedRoots).toEqual(["/tmp/sandbox"]);
    expect(cfg.readOnly).toBe(false);
    expect(cfg.maxBytes).toBe(1_000_000);
  });

  it("parses multiple colon-separated roots", () => {
    const cfg = readSandboxConfigFromEnv({
      MCP_FS_SANDBOX_ALLOWLIST: "/tmp/a:/tmp/b: /tmp/c ",
    });
    expect(cfg.allowedRoots).toEqual(["/tmp/a", "/tmp/b", "/tmp/c"]);
  });

  it("read-only flag accepts `1`, `true`, `yes`", () => {
    for (const v of ["1", "true", "TRUE", "yes"]) {
      const cfg = readSandboxConfigFromEnv({
        MCP_FS_SANDBOX_ALLOWLIST: "/tmp/a",
        MCP_FS_SANDBOX_READ_ONLY: v,
      });
      expect(cfg.readOnly).toBe(true);
    }
  });

  it("read-only flag tolerates surrounding whitespace (#52)", () => {
    // A whitespace-padded affirmative (common from .env / compose env blocks)
    // must still enable read-only — not silently fail open to write mode.
    for (const v of ["1 ", " true", "yes\n", " 1 ", "\tTRUE "]) {
      const cfg = readSandboxConfigFromEnv({
        MCP_FS_SANDBOX_ALLOWLIST: "/tmp/a",
        MCP_FS_SANDBOX_READ_ONLY: v,
      });
      expect(cfg.readOnly).toBe(true);
    }
  });

  it("read-only defaults to false for unset / `0` / random strings", () => {
    for (const v of [undefined, "", "0", "false", "no", "banana"]) {
      const env: NodeJS.ProcessEnv = { MCP_FS_SANDBOX_ALLOWLIST: "/tmp/a" };
      if (v !== undefined) env.MCP_FS_SANDBOX_READ_ONLY = v;
      const cfg = readSandboxConfigFromEnv(env);
      expect(cfg.readOnly).toBe(false);
    }
  });

  it("parses MCP_FS_SANDBOX_MAX_BYTES as positive integer", () => {
    const cfg = readSandboxConfigFromEnv({
      MCP_FS_SANDBOX_ALLOWLIST: "/tmp/a",
      MCP_FS_SANDBOX_MAX_BYTES: "524288",
    });
    expect(cfg.maxBytes).toBe(524288);
  });

  it("rejects non-positive / non-integer max bytes", () => {
    for (const v of ["0", "-1", "1.5", "banana"]) {
      expect(() =>
        readSandboxConfigFromEnv({
          MCP_FS_SANDBOX_ALLOWLIST: "/tmp/a",
          MCP_FS_SANDBOX_MAX_BYTES: v,
        }),
      ).toThrow(/MCP_FS_SANDBOX_MAX_BYTES/);
    }
  });
});
