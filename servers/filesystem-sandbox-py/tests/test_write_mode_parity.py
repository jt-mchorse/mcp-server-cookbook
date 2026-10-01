"""File-mode parity for the atomic write, shared with the TS port (#200).

The atomic helper used to create its temp file with ``NamedTemporaryFile``,
which is always 0600, and ``os.replace`` carried that onto the target. So every
file ``write_file`` created was owner-only regardless of umask, and an
overwrite demoted an existing 0644 file to 0600 — while the plain
``open(path, "wb")`` it replaced honoured the umask and kept the existing mode.
The TS port had the same defect (``fs.open(tmp, ..., 0o600)``).

The table lives in ``test-fixtures/write_mode_parity.json`` and is read by
*both* suites. Every row runs twice: against ``atomic_write_bytes`` directly and
through the real ``write_file`` tool, so a call site that stops routing through
the helper is caught as well. The process umask is set per row and restored in
``finally``.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from filesystem_sandbox.atomic_write import atomic_write_bytes  # noqa: E402
from filesystem_sandbox.sandbox import Sandbox  # noqa: E402
from filesystem_sandbox.tools import ToolDeps, write_file  # noqa: E402

_TABLE_PATH = Path(__file__).resolve().parents[3] / "test-fixtures" / "write_mode_parity.json"


def _load_table() -> dict:
    assert _TABLE_PATH.is_file(), (
        f"shared parity table missing at {_TABLE_PATH}; it is read by both the "
        "TS and Python suites and must not be moved without updating both"
    )
    return json.loads(_TABLE_PATH.read_text(encoding="utf-8"))


_CASES = _load_table()["cases"]


def _via_helper(root: Path, target: Path) -> None:
    atomic_write_bytes(target, b"new content")


def _via_write_file(root: Path, target: Path) -> None:
    deps = ToolDeps(sandbox=Sandbox.create([str(root)]), read_only=False, max_bytes=1024)
    write_file(deps, str(target), "new content")


_ROUTES = {"helper": _via_helper, "write_file": _via_write_file}


def test_shared_table_is_present_and_non_trivial() -> None:
    """A silently empty parity suite is worse than none."""
    assert len(_CASES) >= 5
    assert any(c["preexisting_mode"] is None for c in _CASES)
    assert any(c["preexisting_mode"] is not None for c in _CASES)


@pytest.mark.parametrize("route", sorted(_ROUTES))
@pytest.mark.parametrize("case", _CASES, ids=[c["label"] for c in _CASES])
def test_written_file_mode_matches_the_shared_table(case: dict, route: str, tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    target = root / "out.txt"
    if case["preexisting_mode"] is not None:
        target.write_bytes(b"old content")
        os.chmod(target, int(case["preexisting_mode"], 8))
        # Control: the precondition really holds (chmod of a setuid bit can be
        # silently refused on some filesystems; a refused one is not this row).
        assert stat.S_IMODE(target.stat().st_mode) == int(case["preexisting_mode"], 8)

    old = os.umask(int(case["umask"], 8))
    try:
        _ROUTES[route](root, target)
    finally:
        os.umask(old)

    assert target.read_bytes() == b"new content"
    got = stat.S_IMODE(target.stat().st_mode)
    assert got == int(case["expected_mode"], 8), (
        f"{case['label']} via {route}: mode {oct(got)}, expected 0o{case['expected_mode']}"
    )
    # No temp sibling left behind.
    assert [p.name for p in root.iterdir()] == ["out.txt"]
