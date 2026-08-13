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

export function readSandboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const raw = env.MCP_FS_SANDBOX_ALLOWLIST ?? "";
  const sep = os.platform() === "win32" ? ";" : ":";
  const parts = raw
    .split(sep)
    .map((p) => p.trim())
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
  const ro = (env.MCP_FS_SANDBOX_READ_ONLY ?? "").trim().toLowerCase();
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
  if (maxBytesRaw !== undefined && maxBytesRaw.trim() !== "") {
    const trimmed = maxBytesRaw.trim();
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
