/**
 * A `timeoutMs` can be too large to work as a timeout.
 *
 * `validateConfig` rejects `timeoutMs = 0` because, in its own docstring's
 * words, it "SIGKILLs every child on the next tick". A value at or above
 * `2**31` does exactly that: Node's `setTimeout` clamps any delay past the
 * 32-bit limit to 1 ms, so the kill timer fires a millisecond after spawn.
 * Only the lower bound was closed (#143).
 *
 * The consequence here is heavier than for a network client: the child is
 * SIGKILLed, not merely abandoned, and the resulting `TimeoutError` reports the
 * *configured* value — so an operator who set `1e10` reads "exceeded
 * 10000000000ms timeout" for a process that lived two milliseconds.
 *
 * `maxOutputBytes` is deliberately not covered: it is a byte count compared
 * with `>`, never handed to a timer, so the clamp cannot reach it.
 */
import { describe, expect, it } from "vitest";

import {
  BridgeError,
  MAX_TIMEOUT_MS,
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

const OK_ARGS = ["-e", "process.stdout.write('ok')"];

describe("BridgeConfig.timeoutMs upper bound", () => {
  it("MAX_TIMEOUT_MS is exactly 2**31 - 1", () => {
    expect(MAX_TIMEOUT_MS).toBe(2147483647);
  });

  it.each([2 ** 31, 2 ** 32, 5e9, Number.MAX_SAFE_INTEGER])(
    "rejects timeoutMs=%d",
    async (v) => {
      await expect(runBridged(cfg({ timeoutMs: v }), NODE, OK_ARGS)).rejects.toBeInstanceOf(
        BridgeError,
      );
      await expect(runBridged(cfg({ timeoutMs: v }), NODE, OK_ARGS)).rejects.toThrow(
        /2\*\*31 - 1/,
      );
    },
  );

  it("still accepts the boundary value and runs the child normally", async () => {
    const res = await runBridged(cfg({ timeoutMs: MAX_TIMEOUT_MS }), NODE, OK_ARGS);
    expect(res.stdout).toBe("ok");
  }, 20000);

  it("still accepts an ordinary timeout", async () => {
    const res = await runBridged(cfg({ timeoutMs: 5_000 }), NODE, OK_ARGS);
    expect(res.stdout).toBe("ok");
  }, 20000);

  it("still rejects the lower bound it always did", async () => {
    for (const bad of [0, -1, 1.5]) {
      await expect(runBridged(cfg({ timeoutMs: bad }), NODE, OK_ARGS)).rejects.toBeInstanceOf(
        BridgeError,
      );
    }
  });

  it("the message explains the ceiling rather than just stating it", async () => {
    let msg = "";
    try {
      await runBridged(cfg({ timeoutMs: 2 ** 31 }), NODE, OK_ARGS);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/setTimeout/);
    expect(msg).toMatch(/SIGKILL/);
  });

  it("maxOutputBytes is unaffected — it never reaches a timer", async () => {
    const res = await runBridged(cfg({ maxOutputBytes: 2 ** 31 }), NODE, OK_ARGS);
    expect(res.stdout).toBe("ok");
  }, 20000);
});
