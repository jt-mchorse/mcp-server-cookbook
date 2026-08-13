/**
 * MCP_FS_SANDBOX_MAX_BYTES value-domain parity with the Python port (#137).
 *
 * #98 made the two ports agree on the *grammar* — which literal forms parse.
 * It did not make them agree on the *value domain*, and that is where a
 * float-backed language and an arbitrary-precision one diverge:
 *
 *   - `Number("9007199254740993")` is 9007199254740992, with `Number.isInteger`
 *     and `Number.isFinite` both true — so this port silently applied a cap one
 *     byte below what the operator wrote, while Python applied it exactly.
 *   - A 310-digit value overflowed to `Infinity` here and was rejected, while
 *     Python accepted it and ran with an effectively unbounded cap. That is
 *     verbatim the "starts one port, hard-fails the other" harm #98 set out to
 *     fix.
 *
 * The table lives in `test-fixtures/max_bytes_parity.json` and is read by
 * BOTH suites, so the ports are exercised against literally the same inputs
 * rather than two hand-maintained copies that can drift apart the way the
 * implementations did.
 *
 * Every row asserts the resulting `maxBytes`, not just accept/reject. That is
 * the point: the rounding rows pass an accept/reject-only check on the broken
 * tree, because both ports *accepted* — they just produced different numbers.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSandboxConfigFromEnv } from "../src/config.js";

interface ParityCase {
  label: string;
  raw?: string | null;
  digits?: number;
  accept: boolean;
  max_bytes?: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(HERE, "..", "..", "..", "test-fixtures", "max_bytes_parity.json");

const table = JSON.parse(readFileSync(TABLE_PATH, "utf8")) as {
  default_max_bytes: number;
  max_safe_integer: number;
  cases: ParityCase[];
};

/** `{digits: N}` expands to "1" followed by N-1 zeros. */
function rawFor(c: ParityCase): string | null {
  if (c.digits !== undefined) return "1" + "0".repeat(c.digits - 1);
  return c.raw ?? null;
}

function envFor(c: ParityCase): Record<string, string> {
  const raw = rawFor(c);
  const env: Record<string, string> = { MCP_FS_SANDBOX_ALLOWLIST: "/tmp/a" };
  if (raw !== null) env.MCP_FS_SANDBOX_MAX_BYTES = raw;
  return env;
}

describe("MCP_FS_SANDBOX_MAX_BYTES value-domain parity (#137)", () => {
  it("the shared table is present and non-trivial", () => {
    // If the fixture ever goes missing this must fail loudly rather than
    // vacuously passing zero cases — a silently empty parity suite is worse
    // than none.
    expect(table.cases.length).toBeGreaterThan(20);
    expect(table.max_safe_integer).toBe(Number.MAX_SAFE_INTEGER);
    expect(table.default_max_bytes).toBe(1_000_000);
  });

  for (const c of table.cases) {
    it(`${c.accept ? "accepts" : "rejects"}: ${c.label}`, () => {
      if (!c.accept) {
        expect(() => readSandboxConfigFromEnv(envFor(c))).toThrow(/MCP_FS_SANDBOX_MAX_BYTES/);
        return;
      }
      const cfg = readSandboxConfigFromEnv(envFor(c));
      expect(cfg.maxBytes).toBe(c.max_bytes);
    });
  }

  it("MAX_SAFE_INTEGER is the boundary: accepted, and one above is not", () => {
    const cfg = readSandboxConfigFromEnv({
      MCP_FS_SANDBOX_ALLOWLIST: "/tmp/a",
      MCP_FS_SANDBOX_MAX_BYTES: String(Number.MAX_SAFE_INTEGER),
    });
    expect(cfg.maxBytes).toBe(Number.MAX_SAFE_INTEGER);

    expect(() =>
      readSandboxConfigFromEnv({
        MCP_FS_SANDBOX_ALLOWLIST: "/tmp/a",
        MCP_FS_SANDBOX_MAX_BYTES: String(Number.MAX_SAFE_INTEGER + 1),
      }),
    ).toThrow(/MCP_FS_SANDBOX_MAX_BYTES/);
  });

  it("no accepted value is ever silently rounded", () => {
    // The defect stated directly: for every accepted input, the cap the server
    // enforces must equal the digits the operator wrote. Pre-fix,
    // "9007199254740993" was accepted as 9007199254740992.
    for (const c of table.cases) {
      if (!c.accept) continue;
      const raw = rawFor(c);
      if (raw === null || raw.trim() === "") continue;
      const cfg = readSandboxConfigFromEnv(envFor(c));
      expect(BigInt(cfg.maxBytes)).toBe(BigInt(raw.trim()));
    }
  });
});
