"""Parses the filesystem-sandbox server's environment config.

Mirrors ``../filesystem-sandbox/src/config.ts``:

- ``MCP_FS_SANDBOX_ALLOWLIST`` — colon-separated absolute paths
  (``:`` on Unix; semicolon ``;`` on Windows). Mandatory; an unset or
  empty value refuses to start the server (D-005 — silent permissive
  default would be the worst possible config).
- ``MCP_FS_SANDBOX_READ_ONLY`` — when set to ``1`` / ``true`` /
  ``yes`` (case-insensitive), refuses ``write_file`` calls.
- ``MCP_FS_SANDBOX_MAX_BYTES`` — per-call byte cap. Defaults to 1 MB.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass

DEFAULT_MAX_BYTES = 1_000_000


@dataclass(frozen=True)
class SandboxConfig:
    allowed_roots: tuple[str, ...]
    read_only: bool
    max_bytes: int


def read_sandbox_config_from_env(env: dict[str, str] | None = None) -> SandboxConfig:
    e = env if env is not None else dict(os.environ)
    raw = e.get("MCP_FS_SANDBOX_ALLOWLIST", "")
    sep = ";" if sys.platform == "win32" else ":"
    parts = tuple(p.strip() for p in raw.split(sep) if p.strip())
    if not parts:
        raise ValueError(
            "MCP_FS_SANDBOX_ALLOWLIST is required (colon-separated absolute paths "
            "on Unix; semicolon on Windows). Refusing to start with an empty "
            "allow-list — that would mean every path is rejected, which is a "
            "config bug, not a useful default."
        )

    ro = e.get("MCP_FS_SANDBOX_READ_ONLY", "").lower()
    read_only = ro in ("1", "true", "yes")

    max_bytes_raw = e.get("MCP_FS_SANDBOX_MAX_BYTES", "")
    max_bytes = DEFAULT_MAX_BYTES
    if max_bytes_raw:
        try:
            parsed = int(max_bytes_raw)
        except ValueError as exc:
            raise ValueError(
                f"MCP_FS_SANDBOX_MAX_BYTES must be a positive integer; got {max_bytes_raw!r}"
            ) from exc
        if parsed <= 0:
            raise ValueError(f"MCP_FS_SANDBOX_MAX_BYTES must be a positive integer; got {parsed!r}")
        max_bytes = parsed

    return SandboxConfig(allowed_roots=parts, read_only=read_only, max_bytes=max_bytes)
