/**
 * Parses the filesystem-sandbox server's environment config.
 *
 * `MCP_FS_SANDBOX_ALLOWLIST` — colon-separated absolute paths
 * (`:` on Unix; semicolon `;` on Windows). Mandatory; an unset or
 * empty value refuses to start the server (D-005 — silent permissive
 * default would be the worst possible config).
 *
 * `MCP_FS_SANDBOX_READ_ONLY` — when set to `1` / `true` / `yes`
 * (case-insensitive), the server
 * refuses `write_file` calls. Defaults to permissive (off) since the
 * server's whole point is bounded writes; but operators who want
 * extra defense-in-depth can flip this and be sure no write tool ever
 * touches the filesystem.
 *
 * `MCP_FS_SANDBOX_MAX_BYTES` — per-call read/write byte cap.
 * Defaults to 1 MB. Caller-visible — the tools surface a clear error
 * when the limit is hit, rather than silently truncating.
 */

import os from "node:os";

export interface SandboxConfig {
  allowedRoots: string[];
  readOnly: boolean;
  maxBytes: number;
}

const DEFAULT_MAX_BYTES = 1_000_000;

/**
 * Characters trimmed from every env value, matched exactly by the Python port's
 * `_CONFIG_TRIM` (#139).
 *
 * `#98` made the two ports agree on the byte cap's *grammar* and `#137` on its
 * *value domain*. Both also trim each of the three env values — and
 * `String.prototype.trim()` and Python's `str.strip()` remove **different
 * character sets**, which is a third axis neither of those covered. Measured:
 *
 *   codepoint       | JS trim() | Python strip()
 *   U+0020 / U+0009 | yes       | yes
 *   U+00A0 / U+3000 | yes       | yes
 *   U+0085 NEL      | NO        | yes
 *   U+001C..U+001F  | NO        | yes
 *   U+FEFF BOM      | yes       | NO
 *
 * It cuts both ways, and every affected value diverged on all three variables:
 *
 *   U+FEFF on READ_ONLY  -> this port `true`, Python `false`  (fails OPEN there)
 *   U+0085 on READ_ONLY  -> this port `false` (fails OPEN here), Python `true`
 *   U+FEFF on MAX_BYTES  -> this port 4096, Python refuses to start
 *   U+0085 on MAX_BYTES  -> this port refuses to start, Python 4096
 *   U+FEFF on ALLOWLIST  -> this port `/tmp/sbx`, Python `\ufeff/tmp/sbx`
 *
 * The read-only row is the serious one: it is `#52`'s "silently failed open to
 * *write* mode even though the operator set the read-only safety toggle",
 * reached through a character class instead of ordinary whitespace. And a
 * leading `U+FEFF` is not exotic — it is what a `.env` saved as UTF-8-with-BOM
 * produces, which is the default in several Windows editors and what
 * PowerShell's `Out-File` emits without `-Encoding utf8NoBOM`.
 *
 * The set is the UNION of the two languages': JS `\s` already covers `U+FEFF`,
 * NBSP and the `Zs` category, so the additions here are Python's extras. A
 * union strips strictly more than either did before, so a config that worked on
 * one port now works on both and nothing that worked breaks.
 *
 * `U+200B` (zero-width space) is deliberately NOT included — it is not
 * whitespace in either language, so adding it would be a widening decision
 * rather than a parity fix. A test pins that it stays untrimmed in both ports.
 */
const CONFIG_TRIM_CLASS = "[\\s\\u0085\\u001C-\\u001F]";
const CONFIG_TRIM_RE = new RegExp(`^${CONFIG_TRIM_CLASS}+|${CONFIG_TRIM_CLASS}+$`, "gu");

/** `String.prototype.trim()` widened to the shared set. */
function configTrim(value: string): string {
  return value.replace(CONFIG_TRIM_RE, "");
}

export function readSandboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const raw = env.MCP_FS_SANDBOX_ALLOWLIST ?? "";
  const sep = os.platform() === "win32" ? ";" : ":";
  const parts = raw
    .split(sep)
    .map((p) => configTrim(p))
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(
      "MCP_FS_SANDBOX_ALLOWLIST is required (colon-separated absolute paths on Unix; semicolon on Windows). " +
        "Refusing to start with an empty allow-list — that would mean every path is rejected, which is a config bug, not a useful default.",
    );
  }

  // Trim before comparing, consistent with the allow-list parsing above.
  // Without the trim a whitespace-padded value (`"1 "` from a .env file or a
  // docker-compose `environment:` entry) silently failed open to *write*
  // mode even though the operator set the read-only safety toggle (#52).
  const ro = configTrim(env.MCP_FS_SANDBOX_READ_ONLY ?? "").toLowerCase();
  const readOnly = ro === "1" || ro === "true" || ro === "yes";

  // Canonical grammar for the byte cap: a plain base-10 integer, optional
  // surrounding whitespace, optional leading sign. `Number()` alone would also
  // accept scientific/hex/octal/binary literals (`1e6`→1000000, `0x10`→16,
  // `0o17`→15) — but the Python parity port's `int()` rejects all of those
  // while accepting underscore-grouped digits (`1_000_000`), which `Number()`
  // in turn rejects. That divergence means the same `.env` / docker-compose
  // value starts one port and hard-fails the other (#98). Both ports now gate
  // on the same explicit regex so they accept/reject an identical grammar; the
  // trailing `Number` parse then only ever sees plain digits.
  // #98 made the two ports agree on the *grammar*. It did not make them agree
  // on the *value domain*, and that is where a float-backed language and an
  // arbitrary-precision one diverge (#137):
  //
  //   - `Number("9007199254740993")` is 9007199254740992 — silently one byte
  //     below what the operator wrote, with `Number.isInteger` and
  //     `Number.isFinite` both true, so nothing caught it. Python's `int()`
  //     applied the exact value. Same config, two different caps.
  //   - A 310-digit value overflowed to `Infinity` here and was rejected, while
  //     Python accepted it and ran with an effectively unbounded cap — verbatim
  //     the "starts one port, hard-fails the other" harm #98 set out to fix.
  //
  // MAX_SAFE_INTEGER is the ceiling because it is the largest value this port
  // can represent exactly; under it the two agree by construction rather than
  // by coincidence. A ~9 PB per-call byte cap is not a real configuration, so
  // the bound costs no legitimate use. It also keeps Python's `int()` away from
  // CPython 3.11+'s 4300-digit string limit, whose ValueError text names
  // `sys.set_int_max_str_digits()` instead of this variable.
  const maxBytesRaw = env.MCP_FS_SANDBOX_MAX_BYTES;
  let maxBytes = DEFAULT_MAX_BYTES;
  if (maxBytesRaw !== undefined && configTrim(maxBytesRaw) !== "") {
    const trimmed = configTrim(maxBytesRaw);
    // Reject over-long digit strings before `Number` sees them, so the
    // magnitude check below never depends on a lossy conversion.
    const withinSafeRange =
      /^[+-]?\d+$/.test(trimmed) && BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER);
    const parsed = withinSafeRange ? Number(trimmed) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(
        `MCP_FS_SANDBOX_MAX_BYTES must be a positive integer no greater than ` +
          `${Number.MAX_SAFE_INTEGER}; got ${JSON.stringify(maxBytesRaw)}`,
      );
    }
    maxBytes = parsed;
  }

  return { allowedRoots: parts, readOnly, maxBytes };
}
