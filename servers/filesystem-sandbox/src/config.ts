/**
 * Parses the filesystem-sandbox server's environment config.
 *
 * `MCP_FS_SANDBOX_ALLOWLIST` — colon-separated absolute paths
 * (`:` on Unix; semicolon `;` on Windows). Mandatory; an unset or
 * empty value refuses to start the server (D-005 — silent permissive
 * default would be the worst possible config).
 *
 * `MCP_FS_SANDBOX_READ_ONLY` — when set to `1` / `true`, the server
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

  const maxBytesRaw = env.MCP_FS_SANDBOX_MAX_BYTES;
  let maxBytes = DEFAULT_MAX_BYTES;
  if (maxBytesRaw !== undefined && maxBytesRaw !== "") {
    const parsed = Number(maxBytesRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(
        `MCP_FS_SANDBOX_MAX_BYTES must be a positive integer; got ${JSON.stringify(maxBytesRaw)}`,
      );
    }
    maxBytes = parsed;
  }

  return { allowedRoots: parts, readOnly, maxBytes };
}
