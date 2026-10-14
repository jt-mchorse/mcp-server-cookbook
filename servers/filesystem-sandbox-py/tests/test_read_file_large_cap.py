"""The read cap is an upper bound, not an allocation (#279).

Since #232, ``read_file`` read with ``fh.read(max_bytes + 1)``, which sizes its
buffer by the cap whatever the file's size. ``MCP_FS_SANDBOX_MAX_BYTES`` is
accepted up to ``MAX_SAFE_INTEGER`` (the #137 parity contract), and at that
cap a 5-byte file raised ``MemoryError``. The TS port aborted at 2**31 - 1.
The read is now chunked at ``READ_CHUNK_BYTES`` in both ports.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from filesystem_sandbox.sandbox import Sandbox
from filesystem_sandbox.tools import READ_CHUNK_BYTES, FileTooLargeError, ToolDeps, read_file

MAX_SAFE_INTEGER = 2**53 - 1


def _deps(tmp_path: Path, cap: int) -> ToolDeps:
    return ToolDeps(sandbox=Sandbox.create([os.path.realpath(tmp_path)]), max_bytes=cap)


@pytest.mark.parametrize(
    "cap",
    [2**31 - 2, 2**31 - 1, 2**32, MAX_SAFE_INTEGER],
    ids=["2**31-2", "2**31-1", "2**32", "MAX_SAFE_INTEGER"],
)
def test_a_small_file_reads_under_any_accepted_cap(tmp_path: Path, cap: int) -> None:
    f = Path(os.path.realpath(tmp_path)) / "a.txt"
    f.write_text("hello")
    assert read_file(_deps(tmp_path, cap), str(f)) == "hello"


CAP = 2 * READ_CHUNK_BYTES + 7


def test_a_file_spanning_several_chunks_comes_back_intact(tmp_path: Path) -> None:
    # Not a repeated byte, so a chunk read at the wrong offset changes it.
    body = "".join(chr(97 + i % 26) for i in range(CAP))
    f = Path(os.path.realpath(tmp_path)) / "multi.txt"
    f.write_text(body)
    assert read_file(_deps(tmp_path, CAP), str(f)) == body


def test_one_byte_over_a_multi_chunk_cap_is_refused(tmp_path: Path) -> None:
    f = Path(os.path.realpath(tmp_path)) / "over.txt"
    f.write_text("z" * (CAP + 1))
    with pytest.raises(FileTooLargeError):
        read_file(_deps(tmp_path, CAP), str(f))
