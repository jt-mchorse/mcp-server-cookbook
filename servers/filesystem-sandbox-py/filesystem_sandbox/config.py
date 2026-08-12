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

# `Number.MAX_SAFE_INTEGER` in the TS sibling — the largest integer that port
# represents exactly. Shared ceiling for `MCP_FS_SANDBOX_MAX_BYTES` so the two
# ports agree on the value domain, not just the grammar (#137).
MAX_SAFE_INTEGER = 2**53 - 1
MAX_SAFE_INTEGER_DIGITS = len(str(MAX_SAFE_INTEGER))


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
    #
    # #98 made the two ports agree on the *grammar*. It did not make them agree
    # on the *value domain* (#137). `int()` is arbitrary-precision and `Number()`
    # is float-backed, so above 2**53 the TS port silently rounded
    # (`9007199254740993` -> `...992`) while this one applied the exact value,
    # and a 310-digit value overflowed to `Infinity` there — refusing to start —
    # while this one accepted an effectively unbounded cap.
    #
    # MAX_SAFE_INTEGER (2**53 - 1) is the ceiling because it is the largest
    # value the TS port represents exactly; under it the two agree by
    # construction rather than by coincidence. Checking the digit length before
    # `int()` also keeps CPython 3.11+'s 4300-digit string limit unreachable —
    # its ValueError names `sys.set_int_max_str_digits()` rather than this
    # variable, which is not a message an operator can act on.
    max_bytes_raw = e.get("MCP_FS_SANDBOX_MAX_BYTES", "").strip()
    max_bytes = DEFAULT_MAX_BYTES
    if max_bytes_raw:
        too_long = len(max_bytes_raw.lstrip("+-")) > MAX_SAFE_INTEGER_DIGITS
        if not re.fullmatch(r"[+-]?\d+", max_bytes_raw) or too_long:
            raise ValueError(
                f"MCP_FS_SANDBOX_MAX_BYTES must be a positive integer no greater "
                f"than {MAX_SAFE_INTEGER}; got {max_bytes_raw!r}"
            )
        parsed = int(max_bytes_raw)
        if parsed <= 0 or parsed > MAX_SAFE_INTEGER:
            raise ValueError(
                f"MCP_FS_SANDBOX_MAX_BYTES must be a positive integer no greater "
                f"than {MAX_SAFE_INTEGER}; got {max_bytes_raw!r}"
            )
        max_bytes = parsed

    return SandboxConfig(allowed_roots=parts, read_only=read_only, max_bytes=max_bytes)
