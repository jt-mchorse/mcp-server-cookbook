"""Atomic-write tests for the Python parity port.

Parallels the TS suite at ``../filesystem-sandbox/test/atomic_write.test.ts``.
The load-bearing case here is #100: a target basename at NAME_MAX must be
writable atomically — the temp name must not overflow NAME_MAX by prepending
the full basename (the Python twin of the TS #96 cap).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from filesystem_sandbox.atomic_write import (  # noqa: E402
    MAX_TEMP_BASE_BYTES,
    _cap_base_for_temp,
    atomic_write_bytes,
)


def test_writes_and_round_trips_a_short_basename(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    atomic_write_bytes(target, b"hello world")
    assert target.read_bytes() == b"hello world"
    # No temp sibling left behind on the happy path.
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []


def test_namemax_basename_does_not_overflow_temp_name(tmp_path: Path) -> None:
    # #100 (Python twin of TS #96): a basename the filesystem itself accepts via
    # a plain write must be writable atomically. Pre-fix, the temp name prepended
    # the full basename (`.<base>.<random>.tmp`) and overflowed NAME_MAX, so a
    # name a plain `open(..., "wb")` accepts failed ENAMETOOLONG through the
    # atomic helper.
    base = "a" * 250 + ".json"  # 255-char basename (NAME_MAX on macOS/Linux)

    # Control: the filesystem accepts this exact basename via a plain write.
    plain_target = tmp_path / ("b" + base[1:])
    plain_target.write_bytes(b"plain")
    plain_target.unlink()

    target = tmp_path / base
    data = b"atomic-payload"
    atomic_write_bytes(target, data)
    assert target.read_bytes() == data
    # No temp sibling left behind.
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []


def test_cap_base_for_temp_trims_to_byte_budget() -> None:
    # A short base is returned unchanged; an over-budget base is trimmed to at
    # most MAX_TEMP_BASE_BYTES UTF-8 bytes.
    assert _cap_base_for_temp("short.txt") == "short.txt"
    capped = _cap_base_for_temp("a" * 300)
    assert len(capped.encode("utf-8")) <= MAX_TEMP_BASE_BYTES
    assert capped == "a" * MAX_TEMP_BASE_BYTES


def test_cap_base_for_temp_keeps_multibyte_codepoints_intact() -> None:
    # Trimming by whole characters must not split a multi-byte codepoint, so the
    # result always decodes cleanly. "é" is 2 UTF-8 bytes.
    base = "é" * 200  # 400 UTF-8 bytes
    capped = _cap_base_for_temp(base)
    assert len(capped.encode("utf-8")) <= MAX_TEMP_BASE_BYTES
    # Round-trips without error — no dangling half-codepoint.
    assert capped.encode("utf-8").decode("utf-8") == capped
    assert capped == "é" * (MAX_TEMP_BASE_BYTES // 2)
