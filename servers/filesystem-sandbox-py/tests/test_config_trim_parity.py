"""The two config ports must trim the same character set (#139).

``#98`` made them agree on the byte cap's *grammar* and ``#137`` on its *value
domain*. Both also trim each of the three env values, and ``str.strip()`` and
JS's ``String.prototype.trim()`` remove DIFFERENT sets — a third axis neither of
those covered. Measured on ``main`` @ eb1e431::

    codepoint        | JS trim() | Python strip()
    U+0020 / U+0009  | yes       | yes
    U+00A0 / U+3000  | yes       | yes
    U+2028           | yes       | yes
    U+200B ZWSP      | no        | no
    U+0085 NEL       | NO        | yes
    U+001C..U+001F   | NO        | yes
    U+FEFF BOM       | yes       | NO

It cut both ways, and every affected value diverged on all three variables::

    U+FEFF on READ_ONLY  -> TS true,  this port FALSE  (fails OPEN here)
    U+0085 on READ_ONLY  -> TS false (fails OPEN there), this port true
    U+FEFF on MAX_BYTES  -> TS 4096, this port REFUSED TO START
    U+FEFF on ALLOWLIST  -> TS "/tmp/sbx", this port "\\ufeff/tmp/sbx"

The read-only row is the serious one — ``#52``'s "silently failed open to write
mode even though the operator set the read-only safety toggle", reached through
a character class rather than ordinary whitespace. And a leading ``U+FEFF`` is
not exotic: it is what a ``.env`` saved as UTF-8-with-BOM produces.

Every character here is built with ``chr()``, never written as a literal. While
probing this issue, literal control characters were silently lost twice in
transit through a file, which made a real divergence look like agreement. A test
whose padding character degrades to ``""`` passes vacuously and asserts nothing,
so the construction matters as much as the assertion.

The TypeScript mirror of this file is
``../../filesystem-sandbox/test/config-trim-parity.test.ts``; the two are kept
row-for-row identical so a future divergence shows up as a diff.
"""

from __future__ import annotations

import pytest

from filesystem_sandbox.config import read_sandbox_config_from_env

ROOT = "/tmp/sbx"

# Codepoints the shared trim set must remove, and why each one is here.
SHARED_TRIMMED = [
    (0x0020, "SPACE"),
    (0x0009, "TAB"),
    (0x000A, "LF"),
    (0x000D, "CR"),
    (0x00A0, "NBSP"),
    (0x3000, "IDEOGRAPHIC SPACE"),
    (0x2028, "LINE SEPARATOR"),
    # The ones that diverged.
    (0xFEFF, "BOM / ZWNBSP - kept by Python's strip()"),
    (0x0085, "NEL - kept by JS trim()"),
    (0x001C, "FILE SEPARATOR - kept by JS trim()"),
    (0x001D, "GROUP SEPARATOR - kept by JS trim()"),
    (0x001E, "RECORD SEPARATOR - kept by JS trim()"),
    (0x001F, "UNIT SEPARATOR - kept by JS trim()"),
]

# Not whitespace in either language; widening to it would be a decision.
NOT_TRIMMED = [(0x200B, "ZERO WIDTH SPACE")]

IDS = [f"U+{cp:04X}" for cp, _ in SHARED_TRIMMED]
NOT_IDS = [f"U+{cp:04X}" for cp, _ in NOT_TRIMMED]


def env_with(pad: str, target: str) -> dict[str, str]:
    base = {
        "MCP_FS_SANDBOX_ALLOWLIST": ROOT,
        "MCP_FS_SANDBOX_READ_ONLY": "1",
        "MCP_FS_SANDBOX_MAX_BYTES": "4096",
    }
    # Pad on BOTH sides — a `.env` BOM leads, a shell heredoc newline trails,
    # and the regex has to handle each independently.
    base[target] = pad + base[target] + pad
    return base


# ----------------------------------------------------------------------
# The padding characters really are what they claim to be
# ----------------------------------------------------------------------


def test_every_shared_trimmed_codepoint_is_a_single_real_character() -> None:
    # The anti-vacuous guard for this whole file: if a codepoint silently became
    # "", every assertion below would pass while testing nothing.
    for cp, name in SHARED_TRIMMED:
        c = chr(cp)
        assert len(c) == 1, name
        assert ord(c) == cp, name


def test_records_which_codepoints_python_strip_misses_so_the_premise_is_pinned() -> None:
    # `U+FEFF` is the only one Python's `str.strip()` keeps. If a future CPython
    # widens `str.isspace()`, this fails and the shared-set comment stops being
    # accurate — which is exactly when someone should re-read it.
    missed = [cp for cp, _ in SHARED_TRIMMED if (chr(cp) + "x" + chr(cp)).strip() != "x"]
    assert missed == [0xFEFF]


# ----------------------------------------------------------------------
# READ_ONLY — the safety toggle
# ----------------------------------------------------------------------


@pytest.mark.parametrize(("cp", "name"), SHARED_TRIMMED, ids=IDS)
def test_read_only_stays_true_for_every_trimmed_character(cp: int, name: str) -> None:
    # Pre-fix, U+FEFF made this FALSE in this port — a read-only sandbox that is
    # not read-only, which is the worst outcome this server has.
    cfg = read_sandbox_config_from_env(env_with(chr(cp), "MCP_FS_SANDBOX_READ_ONLY"))
    assert cfg.read_only is True, name


@pytest.mark.parametrize(("cp", "name"), NOT_TRIMMED, ids=NOT_IDS)
def test_read_only_is_false_for_an_untrimmed_character(cp: int, name: str) -> None:
    cfg = read_sandbox_config_from_env(env_with(chr(cp), "MCP_FS_SANDBOX_READ_ONLY"))
    assert cfg.read_only is False, name


# ----------------------------------------------------------------------
# ALLOWLIST
# ----------------------------------------------------------------------


@pytest.mark.parametrize(("cp", "name"), SHARED_TRIMMED, ids=IDS)
def test_allowlist_yields_the_bare_root(cp: int, name: str) -> None:
    # Pre-fix, U+FEFF left the BOM welded to the path, so the root matched
    # nothing and every path was rejected — what D-005 calls a config bug rather
    # than a useful default.
    cfg = read_sandbox_config_from_env(env_with(chr(cp), "MCP_FS_SANDBOX_ALLOWLIST"))
    assert cfg.allowed_roots == (ROOT,), name


@pytest.mark.parametrize(("cp", "name"), NOT_TRIMMED, ids=NOT_IDS)
def test_allowlist_keeps_an_untrimmed_character(cp: int, name: str) -> None:
    c = chr(cp)
    cfg = read_sandbox_config_from_env(env_with(c, "MCP_FS_SANDBOX_ALLOWLIST"))
    assert cfg.allowed_roots == (c + ROOT + c,), name


# ----------------------------------------------------------------------
# MAX_BYTES
# ----------------------------------------------------------------------


@pytest.mark.parametrize(("cp", "name"), SHARED_TRIMMED, ids=IDS)
def test_max_bytes_parses_for_every_trimmed_character(cp: int, name: str) -> None:
    # Pre-fix, U+FEFF made this port REFUSE TO START while the TS port parsed
    # 4096 — verbatim the "starts one port, hard-fails the other" harm #98 was
    # opened to eliminate.
    cfg = read_sandbox_config_from_env(env_with(chr(cp), "MCP_FS_SANDBOX_MAX_BYTES"))
    assert cfg.max_bytes == 4096, name


@pytest.mark.parametrize(("cp", "name"), NOT_TRIMMED, ids=NOT_IDS)
def test_max_bytes_rejects_an_untrimmed_character(cp: int, name: str) -> None:
    with pytest.raises(ValueError, match="MCP_FS_SANDBOX_MAX_BYTES must be a positive integer"):
        read_sandbox_config_from_env(env_with(chr(cp), "MCP_FS_SANDBOX_MAX_BYTES"))


# ----------------------------------------------------------------------
# What must not change
# ----------------------------------------------------------------------


def test_an_unpadded_config_is_unaffected() -> None:
    cfg = read_sandbox_config_from_env(
        {
            "MCP_FS_SANDBOX_ALLOWLIST": "/a:/b",
            "MCP_FS_SANDBOX_READ_ONLY": "yes",
            "MCP_FS_SANDBOX_MAX_BYTES": "4096",
        }
    )
    assert cfg.allowed_roots == ("/a", "/b")
    assert cfg.read_only is True
    assert cfg.max_bytes == 4096


def test_an_all_padding_allowlist_still_refuses_to_start() -> None:
    # The widened set must not turn "nothing but separators" into a valid root.
    pad = "".join(chr(cp) for cp, _ in SHARED_TRIMMED)
    with pytest.raises(ValueError, match="MCP_FS_SANDBOX_ALLOWLIST is required"):
        read_sandbox_config_from_env({"MCP_FS_SANDBOX_ALLOWLIST": pad})


def test_padding_does_not_smuggle_a_value_past_the_max_bytes_grammar() -> None:
    # Trimming more must not mean parsing more: the interior grammar is
    # unchanged, so `1e6` / `0x10` / `1_000` are still rejected however padded.
    bom = chr(0xFEFF)
    for bad in ("1e6", "0x10", "1_000", "-1", "0"):
        with pytest.raises(ValueError, match="MCP_FS_SANDBOX_MAX_BYTES must be a positive integer"):
            read_sandbox_config_from_env(
                {
                    "MCP_FS_SANDBOX_ALLOWLIST": ROOT,
                    "MCP_FS_SANDBOX_MAX_BYTES": bom + bad + bom,
                }
            )


def test_an_interior_separator_is_not_removed_only_leading_and_trailing() -> None:
    # `_config_trim` is anchored. A separator inside a path is part of the path.
    c = chr(0x001C)
    cfg = read_sandbox_config_from_env({"MCP_FS_SANDBOX_ALLOWLIST": f"/a{c}b"})
    assert cfg.allowed_roots == (f"/a{c}b",)
