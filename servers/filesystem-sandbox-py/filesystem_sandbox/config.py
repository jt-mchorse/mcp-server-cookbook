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
import re
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

    # Strip before lowercasing: without it a whitespace-padded value ("1 " from
    # a .env file or a docker-compose `environment:` block, "yes\n", " true")
    # matches no affirmative token and read_only fails OPEN to write mode —
    # silently disabling the operator's read-only safety toggle. Mirrors the
    # allowlist parse above and the TS sibling's `.trim().toLowerCase()`
    # (../filesystem-sandbox/src/config.ts, fixed in #52).
    ro = e.get("MCP_FS_SANDBOX_READ_ONLY", "").strip().lower()
    read_only = ro in ("1", "true", "yes")

    # Canonical grammar for the byte cap: a plain base-10 integer, optional
    # surrounding whitespace, optional leading sign. `int()` alone would also
    # accept underscore-grouped digits (`1_000_000`) and reject scientific/
    # hex/octal/binary — the exact mirror-image of the TS port's `Number()`,
    # which accepts `1e6`/`0x10`/`0o17` but rejects `1_000_000`. That divergence
    # means the same `.env` / docker-compose value starts one port and hard-
    # fails the other (#98). Both ports now gate on the same explicit regex so
    # they accept/reject an identical grammar; the trailing `int()` parse then
    # only ever sees plain digits.
    max_bytes_raw = e.get("MCP_FS_SANDBOX_MAX_BYTES", "").strip()
    max_bytes = DEFAULT_MAX_BYTES
    if max_bytes_raw:
        if not re.fullmatch(r"[+-]?\d+", max_bytes_raw):
            raise ValueError(
                f"MCP_FS_SANDBOX_MAX_BYTES must be a positive integer; got {max_bytes_raw!r}"
            )
        parsed = int(max_bytes_raw)
        if parsed <= 0:
            raise ValueError(f"MCP_FS_SANDBOX_MAX_BYTES must be a positive integer; got {parsed!r}")
        max_bytes = parsed

    return SandboxConfig(allowed_roots=parts, read_only=read_only, max_bytes=max_bytes)
