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

# Characters stripped from every env value, matched exactly by the TS port's
# `CONFIG_TRIM_CLASS` (#139).
#
# `#98` made the two ports agree on the byte cap's *grammar* and `#137` on its
# *value domain*. Both also trim each of the three env values — and
# `str.strip()` and JS's `String.prototype.trim()` remove DIFFERENT character
# sets, a third axis neither of those covered. Measured:
#
#   codepoint        | JS trim() | Python strip()
#   U+0020 / U+0009  | yes       | yes
#   U+00A0 / U+3000  | yes       | yes
#   U+0085 NEL       | NO        | yes
#   U+001C..U+001F   | NO        | yes
#   U+FEFF BOM       | yes       | NO
#
# It cuts both ways, and every affected value diverged on all three variables:
#
#   U+FEFF on READ_ONLY  -> TS ``True``, this port ``False``  (fails OPEN here)
#   U+0085 on READ_ONLY  -> TS ``False`` (fails OPEN there), this port ``True``
#   U+FEFF on MAX_BYTES  -> TS 4096, this port refused to start
#   U+FEFF on ALLOWLIST  -> TS ``/tmp/sbx``, this port ``\ufeff/tmp/sbx``
#
# The read-only row is the serious one: it is `#52`'s "silently failed open to
# *write* mode even though the operator set the read-only safety toggle",
# reached through a character class instead of ordinary whitespace. And a
# leading ``U+FEFF`` is not exotic — it is what a ``.env`` saved as
# UTF-8-with-BOM produces, the default in several Windows editors and what
# PowerShell's ``Out-File`` emits without ``-Encoding utf8NoBOM``.
#
# The set is the UNION of the two languages': Python ``\s`` already covers
# ``U+0085`` and ``U+001C``–``U+001F``, so the addition here is JS's ``U+FEFF``.
# A union strips strictly more than either did before, so a config that worked
# on one port now works on both and nothing that worked breaks.
#
# ``U+200B`` (zero-width space) is deliberately NOT included — it is not
# whitespace in either language, so adding it would be a widening decision
# rather than a parity fix. A test pins that it stays untrimmed in both ports.
_CONFIG_TRIM_RE = re.compile(r"^[\s\ufeff]+|[\s\ufeff]+$")


def _config_trim(value: str) -> str:
    """``str.strip()`` widened to the set shared with the TS port."""
    return _CONFIG_TRIM_RE.sub("", value)


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
    parts = tuple(_config_trim(p) for p in raw.split(sep) if _config_trim(p))
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
    ro = _config_trim(e.get("MCP_FS_SANDBOX_READ_ONLY", "")).lower()
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
    #
    # Two more places the ports read the same literal differently (#287):
    #
    #   - `[0-9]`, not `\d`. A `str` pattern's `\d` is every Unicode `Nd` digit
    #     and `int()` parses them, so Arabic-Indic `٤٠٩٦` booted this port with
    #     a 4096-byte cap while the TS port's `\d` (ASCII only) refused it.
    #   - The length bound counts SIGNIFICANT digits. It counted the literal, so
    #     `09007199254740991` -- MAX_SAFE_INTEGER, zero-padded -- was refused as
    #     "no greater than 9007199254740991", while the TS port's BigInt bound
    #     accepted it. Leading zeros are stripped before `int()` too, so a long
    #     run of them still never reaches the 4300-digit limit.
    max_bytes_raw = _config_trim(e.get("MCP_FS_SANDBOX_MAX_BYTES", ""))
    max_bytes = DEFAULT_MAX_BYTES
    if max_bytes_raw:
        m = re.fullmatch(r"([+-]?)([0-9]+)", max_bytes_raw)
        significant = (m.group(2).lstrip("0") or "0") if m else ""
        if not m or len(significant) > MAX_SAFE_INTEGER_DIGITS:
            raise ValueError(
                f"MCP_FS_SANDBOX_MAX_BYTES must be a positive integer no greater "
                f"than {MAX_SAFE_INTEGER}; got {max_bytes_raw!r}"
            )
        parsed = int(m.group(1) + significant)
        if parsed <= 0 or parsed > MAX_SAFE_INTEGER:
            raise ValueError(
                f"MCP_FS_SANDBOX_MAX_BYTES must be a positive integer no greater "
                f"than {MAX_SAFE_INTEGER}; got {max_bytes_raw!r}"
            )
        max_bytes = parsed

    return SandboxConfig(allowed_roots=parts, read_only=read_only, max_bytes=max_bytes)
