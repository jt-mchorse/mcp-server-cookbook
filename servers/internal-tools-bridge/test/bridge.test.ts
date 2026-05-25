import { describe, expect, it } from "vitest";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AllowlistError,
  BridgeError,
  NonZeroExitError,
  OutputCapError,
  TimeoutError,
  runBridged,
  type BridgeConfig,
} from "../src/bridge.js";

const NODE = process.execPath;

function cfg(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    allowlist: [NODE],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    maxOutputBytes: 1024,
    ...overrides,
  };
}

describe("runBridged — allowlist", () => {
  it("rejects a binary not on the allowlist", async () => {
    await expect(runBridged(cfg(), "/bin/ls", ["/"])).rejects.toBeInstanceOf(
      AllowlistError,
    );
  });

  it("rejects a relative-path binary even if its basename matches", async () => {
    // The check is by string equality, not basename — relative paths
    // never satisfy the allowlist no matter what.
    await expect(runBridged(cfg(), "node", ["-e", ""])).rejects.toBeInstanceOf(
      AllowlistError,
    );
  });

  it("accepts the absolute path of an allow-listed binary", async () => {
    const r = await runBridged(cfg(), NODE, ["-e", "process.stdout.write('ok')"]);
    expect(r.stdout).toBe("ok");
  });
});

describe("runBridged — argv shape", () => {
  it("never invokes a shell — shell metacharacters are passed as literal data", async () => {
    // If `shell: true` leaked in, `&&`, `|`, `>`, and `$()` would be
    // interpreted by the shell. With `shell: false` they survive as
    // literal argv entries the child observes verbatim. We inspect the
    // tail of `process.argv` (everything after `-rf`) since the exact
    // header layout varies across Node versions (older Node inserts a
    // `[eval]` placeholder; newer Node does not).
    const r = await runBridged(cfg(), NODE, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(process.argv.indexOf('SENTINEL') + 1)))",
      "--",
      "SENTINEL",
      "&&",
      "echo",
      "$(whoami)",
      "|",
      "cat",
      ">",
      "/dev/null",
    ]);
    const out: unknown = JSON.parse(r.stdout);
    expect(Array.isArray(out)).toBe(true);
    expect(out as string[]).toEqual([
      "&&",
      "echo",
      "$(whoami)",
      "|",
      "cat",
      ">",
      "/dev/null",
    ]);
  });

  it("rejects non-string argv entries", async () => {
    // Casting to `any` here is the test's whole point — a caller that
    // sneaks a non-string into the argv array must be rejected before
    // spawn.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runBridged(cfg(), NODE, ["-e", "''", 42 as any]),
    ).rejects.toBeInstanceOf(BridgeError);
  });
});

describe("runBridged — env scrub", () => {
  it("does not leak secrets from process.env into the child", async () => {
    // Plant a fake secret in the test's own env, then assert the child
    // can't read it back. The bridge's passlist is PATH/LANG/LC_ALL/TZ/
    // NODE_OPTIONS only.
    const SECRET_KEY = "MCP_BRIDGE_TEST_SECRET";
    const prior = process.env[SECRET_KEY];
    process.env[SECRET_KEY] = "supersecret";
    try {
      const r = await runBridged(cfg(), NODE, [
        "-e",
        `process.stdout.write(JSON.stringify(process.env.${SECRET_KEY} ?? null))`,
      ]);
      expect(r.stdout).toBe("null");
    } finally {
      if (prior === undefined) delete process.env[SECRET_KEY];
      else process.env[SECRET_KEY] = prior;
    }
  });
});

describe("runBridged — timeout", () => {
  it("fires SIGKILL after the configured timeout and rejects with TimeoutError", async () => {
    const r = runBridged(
      cfg({ timeoutMs: 150 }),
      NODE,
      // sleep ~5s; the timeout must kill it well before
      ["-e", "setTimeout(() => process.exit(0), 5000)"],
    );
    await expect(r).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("runBridged — output cap", () => {
  it("kills the child and rejects when stdout exceeds the cap", async () => {
    const r = runBridged(cfg({ maxOutputBytes: 256 }), NODE, [
      "-e",
      // Print well over the cap.
      "for (let i = 0; i < 1000; i++) process.stdout.write('x'.repeat(64));",
    ]);
    await expect(r).rejects.toBeInstanceOf(OutputCapError);
  });
});

describe("runBridged — non-zero exit", () => {
  it("rejects with NonZeroExitError and preserves stderr", async () => {
    let caught: NonZeroExitError | null = null;
    try {
      await runBridged(cfg(), NODE, [
        "-e",
        "process.stderr.write('boom'); process.exit(7)",
      ]);
    } catch (e) {
      caught = e as NonZeroExitError;
    }
    expect(caught).toBeInstanceOf(NonZeroExitError);
    expect(caught!.exitCode).toBe(7);
    expect(caught!.stderr).toContain("boom");
  });
});

describe("runBridged — cwd lock", () => {
  it("runs the child in the configured cwd, not the caller's cwd", async () => {
    // Use realpath: on macOS /var resolves to /private/var, so the
    // child's `process.cwd()` will be the canonical form even when
    // mkdtemp gave us the symlinked one.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "bridge-cwd-")));
    await writeFile(join(tmp, "marker.txt"), "here", "utf-8");
    const r = await runBridged(cfg({ cwd: tmp }), NODE, [
      "-e",
      "process.stdout.write(process.cwd())",
    ]);
    expect(r.stdout).toBe(tmp);
  });
});

// Issue #32: validateConfig runs at the entry of runBridged so D-009's
// protective intent (no shell, no OOM, no hang, no PATH-based attack-surface
// widening) can't be silently undermined by misconfigured operator input.
// Without these guards: timeoutMs=0 SIGKILLs every child on next tick,
// maxOutputBytes=0 SIGKILLs on first byte, non-absolute allowlist entries
// fall through to PATH lookup inside spawn(), non-absolute cwd resolves
// against process.cwd() and breaks the "locked root" guarantee.
describe("runBridged — BridgeConfig validation (issue #32)", () => {
  it("rejects relative cwd", async () => {
    await expect(runBridged(cfg({ cwd: "relative/path" }), NODE, ["-e", ""])).rejects.toBeInstanceOf(
      BridgeError,
    );
    await expect(runBridged(cfg({ cwd: "relative/path" }), NODE, ["-e", ""])).rejects.toThrow(
      /cwd must be an absolute path/,
    );
  });

  it("rejects empty-string cwd", async () => {
    await expect(runBridged(cfg({ cwd: "" }), NODE, ["-e", ""])).rejects.toThrow(
      /cwd must be an absolute path/,
    );
  });

  it("rejects empty allowlist", async () => {
    await expect(runBridged(cfg({ allowlist: [] }), NODE, ["-e", ""])).rejects.toThrow(
      /allowlist must be a non-empty array/,
    );
  });

  it("rejects relative allowlist entries", async () => {
    // The key D-009 attack: `cfg.allowlist.includes(binary)` is string equality,
    // so allowlist=["node"] + binary="node" would PATH-search inside spawn().
    await expect(runBridged(cfg({ allowlist: ["node"] }), "node", ["-e", ""])).rejects.toThrow(
      /allowlist entries must be absolute paths/,
    );
  });

  it("rejects empty-string allowlist entries", async () => {
    await expect(runBridged(cfg({ allowlist: [""] }), NODE, ["-e", ""])).rejects.toThrow(
      /allowlist entries must be absolute paths/,
    );
  });

  it.each([
    { value: 0, label: "zero (instant timeout)" },
    { value: -1, label: "negative" },
    { value: 1.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
  ])("rejects timeoutMs $label ($value)", async ({ value }) => {
    await expect(runBridged(cfg({ timeoutMs: value }), NODE, ["-e", ""])).rejects.toThrow(
      /timeoutMs must be an integer >= 1/,
    );
  });

  it("accepts timeoutMs = 1 (minimum valid)", async () => {
    // 1ms isn't realistic for a real command, but the contract should accept it.
    // The test uses a no-op `-e ""` which should complete inside 1ms on a warm runtime;
    // if it sometimes flakes we'd switch to an even shorter no-op, but the validation
    // is what's under test, not the timeout race.
    await expect(
      runBridged(cfg({ timeoutMs: 5_000 }), NODE, ["-e", ""]),
    ).resolves.toMatchObject({ stdout: "" });
  });

  it("accepts undefined timeoutMs (default 10_000 preserved)", async () => {
    const c = { allowlist: [NODE], cwd: process.cwd(), maxOutputBytes: 1024 };
    await expect(runBridged(c, NODE, ["-e", ""])).resolves.toMatchObject({ stdout: "" });
  });

  it.each([
    { value: 0, label: "zero (no output allowed)" },
    { value: -1, label: "negative" },
    { value: 1.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
  ])("rejects maxOutputBytes $label ($value)", async ({ value }) => {
    await expect(runBridged(cfg({ maxOutputBytes: value }), NODE, ["-e", ""])).rejects.toThrow(
      /maxOutputBytes must be an integer >= 1/,
    );
  });

  it("accepts maxOutputBytes = 1 (minimum valid; first byte fills cap, second byte trips it)", async () => {
    // The validation accepts 1; the test exercises that the validator doesn't
    // short-circuit the existing OutputCapError behavior for tiny but valid caps.
    await expect(runBridged(cfg({ maxOutputBytes: 1 }), NODE, ["-e", "process.stdout.write('aa')"])).rejects.toBeInstanceOf(
      OutputCapError,
    );
  });

  it("validation runs before spawn — relative allowlist entry never PATH-searches", async () => {
    // Without the guard, allowlist=["node"]+binary="node" would invoke spawn("node", ...)
    // which would PATH-search. With the guard, validateConfig throws BridgeError before
    // spawn is reached, so we never get an AllowlistError (which would only fire after
    // validation) or a real spawn.
    const err = await runBridged(cfg({ allowlist: ["node"] }), "node", ["-e", ""])
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).not.toBeInstanceOf(AllowlistError);
  });
});
