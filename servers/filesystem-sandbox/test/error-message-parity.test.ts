/**
 * Error-message parity with the Python port (#148, D-010).
 *
 * Four shared tables preceded this one — MAX_BYTES grammar (#98), max-bytes
 * value domain (#137), config trim charset (#139), and `resolve()` (#141) — and
 * every one covers an **internal**: how a config value is trimmed, how a path
 * resolves, what byte budget is accepted. The string a client reads when a call
 * is refused had never been compared, and all four arms diverged:
 *
 *     arm             TypeScript                                   Python
 *     SandboxEscape   sandbox refusal (outside_allowlist): /etc/passwd
 *                                                                  sandbox_escape (outside_allowlist): outside_allowlist: '/etc/passwd'
 *     generic error   content must be a string                     value_error: content must be a string
 *
 * Two of those were defects on their own terms, not parity preferences. Python
 * repeated the reason, because `SandboxEscape.__init__` already puts
 * `f"{reason}: {input!r}"` into the message. And its `value_error:` prefix had
 * no counterpart here at all, though both ports raise the *same message text*
 * at the corresponding sites.
 *
 * `filesystem-sandbox-py`'s README calls itself "a line-for-line port … same
 * threat model, same tools". This is the table that makes that true of the one
 * surface a caller actually sees.
 *
 * The table lives in `test-fixtures/error_message_parity.json` and is read by
 * BOTH suites, so the ports are exercised against literally the same
 * expectations rather than two hand-maintained copies that can drift apart the
 * way the implementations did.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SandboxEscape, type SandboxEscapeReason } from "../src/sandbox.js";
import { errorMessage, FileTooLargeError, WriteForbiddenError } from "../src/tools.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = path.resolve(HERE, "../../../test-fixtures/error_message_parity.json");

interface Case {
  name: string;
  kind: "sandbox_escape" | "write_forbidden" | "file_too_large" | "generic";
  reason?: string;
  input?: string;
  size?: number;
  limit?: number;
  message?: string;
  expected: string;
}

const table = JSON.parse(readFileSync(TABLE, "utf8")) as { _comment: string[]; cases: Case[] };

function buildError(c: Case): unknown {
  switch (c.kind) {
    case "sandbox_escape":
      return new SandboxEscape(c.reason as SandboxEscapeReason, c.input as string);
    case "write_forbidden":
      return new WriteForbiddenError();
    case "file_too_large":
      return new FileTooLargeError(c.size as number, c.limit as number);
    case "generic":
      return new Error(c.message as string);
  }
}

describe("error-message parity with the Python port", () => {
  it("the shared table is present and non-trivial", () => {
    // Same anti-vacuous guard the other four parity suites carry: a table that
    // failed to load, or shrank to the happy path, must fail loudly rather than
    // silently asserting nothing.
    expect(table.cases.length).toBeGreaterThanOrEqual(10);
    const kinds = new Set(table.cases.map((c) => c.kind));
    expect(kinds).toEqual(
      new Set(["sandbox_escape", "write_forbidden", "file_too_large", "generic"]),
    );
  });

  it("every arm of errorMessage is represented", () => {
    // The four `if` branches. A fifth arm added later without a row here would
    // be an unpinned client-visible string.
    expect(table.cases.filter((c) => c.kind === "sandbox_escape").length).toBeGreaterThanOrEqual(6);
    expect(table.cases.some((c) => c.kind === "write_forbidden")).toBe(true);
    expect(table.cases.some((c) => c.kind === "file_too_large")).toBe(true);
    expect(table.cases.some((c) => c.kind === "generic")).toBe(true);
  });

  it("the table covers the inputs that make quoting load-bearing", () => {
    // A space, a NUL, a trailing separator, an empty string, and a quote — the
    // shapes an unquoted interpolation renders ambiguously. Without these the
    // quoting half of D-010 would be untested.
    const inputs = table.cases.filter((c) => c.kind === "sandbox_escape").map((c) => c.input);
    expect(inputs).toContain("");
    expect(inputs.some((i) => i?.includes(" "))).toBe(true);
    expect(inputs.some((i) => i?.includes(String.fromCharCode(0)))).toBe(true);
    expect(inputs.some((i) => i?.endsWith("/"))).toBe(true);
    expect(inputs.some((i) => i?.includes('"'))).toBe(true);
  });

  for (const c of table.cases) {
    it(`${c.name}`, () => {
      expect(errorMessage(buildError(c))).toBe(c.expected);
    });
  }
});
