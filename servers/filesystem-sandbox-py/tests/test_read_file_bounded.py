"""read_file's cap holds even when the file grows during the call (#232).

It checked `os.path.getsize(path)` and then read `open(path).read()` whole, so
a file that grew in between came back in full, past the cap. The growth is
made deterministic here by appending right after the handle's `fstat`.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from filesystem_sandbox import tools
from filesystem_sandbox.sandbox import Sandbox
from filesystem_sandbox.tools import FileTooLargeError, ToolDeps, read_file

LIMIT = 1024


@pytest.fixture
def deps(tmp_path: Path) -> ToolDeps:
    return ToolDeps(sandbox=Sandbox.create([os.path.realpath(tmp_path)]), max_bytes=LIMIT)


def test_content_that_grew_past_the_cap_after_the_check_is_refused(
    deps: ToolDeps, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = Path(os.path.realpath(tmp_path)) / "log.txt"
    f.write_text("x")
    real_fstat = os.fstat

    def growing_fstat(fd: int) -> os.stat_result:
        st = real_fstat(fd)
        with open(f, "a") as out:
            out.write("y" * (5 * LIMIT))
        return st

    monkeypatch.setattr(tools.os, "fstat", growing_fstat)
    with pytest.raises(FileTooLargeError):
        read_file(deps, str(f))


def test_a_file_exactly_at_the_cap_is_read_in_full(deps: ToolDeps, tmp_path: Path) -> None:
    f = Path(os.path.realpath(tmp_path)) / "edge.txt"
    f.write_text("z" * LIMIT)
    assert read_file(deps, str(f)) == "z" * LIMIT


def test_a_file_over_the_cap_at_the_check_is_refused_with_its_size(
    deps: ToolDeps, tmp_path: Path
) -> None:
    f = Path(os.path.realpath(tmp_path)) / "big.txt"
    f.write_text("z" * (LIMIT + 1))
    with pytest.raises(FileTooLargeError, match=f"file size {LIMIT + 1} > limit {LIMIT} bytes"):
        read_file(deps, str(f))
