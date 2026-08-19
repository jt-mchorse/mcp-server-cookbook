// The two config ports must trim the same character set (#139).
//
// `#98` made them agree on the byte cap's *grammar* and `#137` on its *value
// domain*. Both also trim each of the three env values, and
// `String.prototype.trim()` and Python's `str.strip()` remove DIFFERENT sets —
// a third axis neither of those covered. Measured on `main` @ eb1e431:
//
//   codepoint        | JS trim() | Python strip()
//   U+0020 / U+0009  | yes       | yes
//   U+00A0 / U+3000  | yes       | yes
//   U+2028           | yes       | yes
//   U+200B ZWSP      | no        | no
//   U+0085 NEL       | NO        | yes
//   U+001C..U+001F   | NO        | yes
//   U+FEFF BOM       | yes       | NO
//
// It cut both ways, and every affected value diverged on all three variables:
//
//   U+FEFF on READ_ONLY  -> this port true,  Python false  (fails OPEN there)
//   U+0085 on READ_ONLY  -> this port false (fails OPEN here), Python true
//   U+FEFF on MAX_BYTES  -> this port 4096, Python refused to start
//   U+0085 on MAX_BYTES  -> this port refused to start, Python 4096
//   U+FEFF on ALLOWLIST  -> this port "/tmp/sbx", Python "\ufeff/tmp/sbx"
//
// The read-only row is the serious one — `#52`'s "silently failed open to write
// mode even though the operator set the read-only safety toggle", reached
// through a character class rather than ordinary whitespace.
//
// Every character here is built with `String.fromCodePoint`, never written as a
// literal. While probing this issue, literal control characters were silently
// lost twice in transit through a file, which made a real divergence look like
// agreement. A test whose padding character degrades to "" passes vacuously and
// asserts nothing, so the construction matters as much as the assertion.
//
// The Python mirror of this file is
// `../../filesystem-sandbox-py/tests/test_config_trim_parity.py`; the two are
// kept row-for-row identical so a future divergence shows up as a diff.

import { describe, expect, it } from "vitest";
import { readSandboxConfigFromEnv } from "../src/config.js";

/** Codepoints the shared trim set must remove, and the harm each one caused. */
const SHARED_TRIMMED = [
  { cp: 0x0020, name: "SPACE" },
  { cp: 0x0009, name: "TAB" },
  { cp: 0x000a, name: "LF" },
  { cp: 0x000d, name: "CR" },
  { cp: 0x00a0, name: "NBSP" },
  { cp: 0x3000, name: "IDEOGRAPHIC SPACE" },
  { cp: 0x2028, name: "LINE SEPARATOR" },
  // The three that diverged.
  { cp: 0xfeff, name: "BOM / ZWNBSP — kept by Python's strip()" },
  { cp: 0x0085, name: "NEL — kept by JS trim()" },
  { cp: 0x001c, name: "FILE SEPARATOR — kept by JS trim()" },
  { cp: 0x001d, name: "GROUP SEPARATOR — kept by JS trim()" },
  { cp: 0x001e, name: "RECORD SEPARATOR — kept by JS trim()" },
  { cp: 0x001f, name: "UNIT SEPARATOR — kept by JS trim()" },
] as const;

/** Not whitespace in either language; widening to it would be a decision. */
const NOT_TRIMMED = [{ cp: 0x200b, name: "ZERO WIDTH SPACE" }] as const;

const ROOT = "/tmp/sbx";

function envWith(pad: string, target: string): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    MCP_FS_SANDBOX_ALLOWLIST: ROOT,
    MCP_FS_SANDBOX_READ_ONLY: "1",
    MCP_FS_SANDBOX_MAX_BYTES: "4096",
  };
  // Pad on BOTH sides — a `.env` BOM leads, a shell heredoc trailing newline
  // trails, and the regex has to handle each independently.
  base[target] = pad + base[target] + pad;
  return base as NodeJS.ProcessEnv;
}

describe("the padding characters really are what they claim to be (#139)", () => {
  it("every SHARED_TRIMMED codepoint is a non-empty single character", () => {
    // The anti-vacuous guard for this whole file: if a codepoint silently
    // became "", every assertion below would pass while testing nothing.
    for (const { cp, name } of SHARED_TRIMMED) {
      const c = String.fromCodePoint(cp);
      expect(c.length, name).toBe(1);
      expect(c.codePointAt(0), name).toBe(cp);
    }
  });

  it("records which codepoints JS trim() misses, so the premise is pinned", () => {
    // If a future V8 widens `trim()`, this fails and the shared-set comment
    // stops being accurate — which is exactly when someone should re-read it.
    const missedByJs = SHARED_TRIMMED.filter(({ cp }) => {
      const c = String.fromCodePoint(cp);
      return (c + "x" + c).trim() !== "x";
    }).map(({ cp }) => cp);
    expect(missedByJs).toEqual([0x0085, 0x001c, 0x001d, 0x001e, 0x001f]);
  });
});

describe("READ_ONLY resolves identically for every trimmed character (#139)", () => {
  it.each(SHARED_TRIMMED)("$name (U+$cp) keeps READ_ONLY=1 meaning true", ({ cp }) => {
    // Pre-fix, U+0085 / U+001C..1F made this FALSE in this port — a read-only
    // sandbox that is not read-only, which is the worst outcome this server has.
    const cfg = readSandboxConfigFromEnv(envWith(String.fromCodePoint(cp), "MCP_FS_SANDBOX_READ_ONLY"));
    expect(cfg.readOnly).toBe(true);
  });

  it.each(NOT_TRIMMED)("$name (U+$cp) is NOT trimmed, so READ_ONLY does not match", ({ cp }) => {
    const cfg = readSandboxConfigFromEnv(envWith(String.fromCodePoint(cp), "MCP_FS_SANDBOX_READ_ONLY"));
    expect(cfg.readOnly).toBe(false);
  });
});

describe("ALLOWLIST resolves identically for every trimmed character (#139)", () => {
  it.each(SHARED_TRIMMED)("$name (U+$cp) yields the bare root", ({ cp }) => {
    // Pre-fix, U+0085 / U+001C..1F left the character welded to the path, so
    // the root matched nothing and every path was rejected — what D-005 calls
    // a config bug rather than a useful default.
    const cfg = readSandboxConfigFromEnv(envWith(String.fromCodePoint(cp), "MCP_FS_SANDBOX_ALLOWLIST"));
    expect(cfg.allowedRoots).toEqual([ROOT]);
  });

  it.each(NOT_TRIMMED)("$name (U+$cp) stays welded to the path", ({ cp }) => {
    const c = String.fromCodePoint(cp);
    const cfg = readSandboxConfigFromEnv(envWith(c, "MCP_FS_SANDBOX_ALLOWLIST"));
    expect(cfg.allowedRoots).toEqual([c + ROOT + c]);
  });
});

describe("MAX_BYTES resolves identically for every trimmed character (#139)", () => {
  it.each(SHARED_TRIMMED)("$name (U+$cp) parses to 4096", ({ cp }) => {
    // Pre-fix, U+0085 / U+001C..1F made this port REFUSE TO START while Python
    // parsed 4096 — verbatim the "starts one port, hard-fails the other" harm
    // #98 was opened to eliminate.
    const cfg = readSandboxConfigFromEnv(envWith(String.fromCodePoint(cp), "MCP_FS_SANDBOX_MAX_BYTES"));
    expect(cfg.maxBytes).toBe(4096);
  });

  it.each(NOT_TRIMMED)("$name (U+$cp) is rejected, in both ports", ({ cp }) => {
    expect(() =>
      readSandboxConfigFromEnv(envWith(String.fromCodePoint(cp), "MCP_FS_SANDBOX_MAX_BYTES")),
    ).toThrow(/MCP_FS_SANDBOX_MAX_BYTES must be a positive integer/);
  });
});

describe("what must not change (#139)", () => {
  it("an unpadded config is unaffected", () => {
    const cfg = readSandboxConfigFromEnv({
      MCP_FS_SANDBOX_ALLOWLIST: "/a:/b",
      MCP_FS_SANDBOX_READ_ONLY: "yes",
      MCP_FS_SANDBOX_MAX_BYTES: "4096",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ allowedRoots: ["/a", "/b"], readOnly: true, maxBytes: 4096 });
  });

  it("an all-padding allowlist still refuses to start", () => {
    // The widened set must not turn "nothing but separators" into a valid root.
    const pad = SHARED_TRIMMED.map(({ cp }) => String.fromCodePoint(cp)).join("");
    expect(() =>
      readSandboxConfigFromEnv({ MCP_FS_SANDBOX_ALLOWLIST: pad } as NodeJS.ProcessEnv),
    ).toThrow(/MCP_FS_SANDBOX_ALLOWLIST is required/);
  });

  it("padding does not smuggle a value past the max-bytes grammar", () => {
    // Trimming more must not mean parsing more: the interior grammar is
    // unchanged, so `1e6` and `0x10` are still rejected however they are padded.
    const bom = String.fromCodePoint(0xfeff);
    for (const bad of ["1e6", "0x10", "1_000", "-1", "0"]) {
      expect(() =>
        readSandboxConfigFromEnv({
          MCP_FS_SANDBOX_ALLOWLIST: ROOT,
          MCP_FS_SANDBOX_MAX_BYTES: bom + bad + bom,
        } as NodeJS.ProcessEnv),
      ).toThrow(/MCP_FS_SANDBOX_MAX_BYTES must be a positive integer/);
    }
  });

  it("an interior separator is not removed, only leading and trailing", () => {
    // `configTrim` is anchored. A separator inside a path is part of the path.
    const c = String.fromCodePoint(0x001c);
    const cfg = readSandboxConfigFromEnv({
      MCP_FS_SANDBOX_ALLOWLIST: `/a${c}b`,
    } as NodeJS.ProcessEnv);
    expect(cfg.allowedRoots).toEqual([`/a${c}b`]);
  });
});
