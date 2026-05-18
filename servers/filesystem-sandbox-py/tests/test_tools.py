"""Tool-handler tests for the Python parity port.

Same shape as the TS suite at ``../filesystem-sandbox/test/tools.test.ts``:
list / read / write happy paths plus the dependency-injection knobs
(read-only, byte cap, sandbox-escape propagation).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from filesystem_sandbox.sandbox import Sandbox, SandboxEscape  # noqa: E402
from filesystem_sandbox.tools import (  # noqa: E402
    FileTooLargeError,
    ToolDeps,
    WriteForbiddenError,
    list_directory,
    read_file,
    write_file,
)


@pytest.fixture
def deps(tmp_path: Path) -> ToolDeps:
    root = tmp_path / "root"
    root.mkdir()
    sandbox = Sandbox.create([str(root)])
    return ToolDeps(sandbox=sandbox, read_only=False, max_bytes=1024)


# --- list_directory ---


def test_list_directory_sorted_by_name(deps: ToolDeps, tmp_path: Path):
    root = tmp_path / "root"
    (root / "z.txt").write_text("z", encoding="utf-8")
    (root / "a.txt").write_text("a", encoding="utf-8")
    (root / "m.txt").write_text("m", encoding="utf-8")
    entries = list_directory(deps, str(root))
    assert [e.name for e in entries] == ["a.txt", "m.txt", "z.txt"]
    assert all(e.kind == "file" for e in entries)
    assert entries[0].size == 1


def test_list_directory_reports_subdirectories(deps: ToolDeps, tmp_path: Path):
    root = tmp_path / "root"
    (root / "sub").mkdir()
    (root / "file.txt").write_text("x", encoding="utf-8")
    entries = list_directory(deps, str(root))
    by_name = {e.name: e for e in entries}
    assert by_name["sub"].kind == "directory"
    assert by_name["file.txt"].kind == "file"


def test_list_directory_propagates_sandbox_escape(deps: ToolDeps, tmp_path: Path):
    outsider = tmp_path / "elsewhere"
    outsider.mkdir()
    with pytest.raises(SandboxEscape):
        list_directory(deps, str(outsider))


# --- read_file ---


def test_read_file_returns_utf8_text(deps: ToolDeps, tmp_path: Path):
    target = tmp_path / "root" / "x.txt"
    target.write_text("hello, world", encoding="utf-8")
    assert read_file(deps, str(target)) == "hello, world"


def test_read_file_refuses_files_over_cap(deps: ToolDeps, tmp_path: Path):
    target = tmp_path / "root" / "big.txt"
    target.write_text("x" * 2000, encoding="utf-8")
    with pytest.raises(FileTooLargeError) as ei:
        read_file(deps, str(target))
    assert ei.value.size == 2000
    assert ei.value.limit == 1024


def test_read_file_refuses_binary_content(deps: ToolDeps, tmp_path: Path):
    target = tmp_path / "root" / "bin"
    target.write_bytes(b"\xff\xfe\xff")
    with pytest.raises(ValueError, match="not valid UTF-8"):
        read_file(deps, str(target))


def test_read_file_propagates_sandbox_escape(deps: ToolDeps, tmp_path: Path):
    outsider = tmp_path / "elsewhere"
    outsider.mkdir()
    secret = outsider / "secret.txt"
    secret.write_text("nope", encoding="utf-8")
    with pytest.raises(SandboxEscape):
        read_file(deps, str(secret))


# --- write_file ---


def test_write_file_creates_new_file(deps: ToolDeps, tmp_path: Path):
    target = tmp_path / "root" / "new.txt"
    out = write_file(deps, str(target), "hello")
    assert out == {"bytes_written": 5}
    assert target.read_text(encoding="utf-8") == "hello"


def test_write_file_overwrites_existing_file(deps: ToolDeps, tmp_path: Path):
    target = tmp_path / "root" / "x.txt"
    target.write_text("old", encoding="utf-8")
    out = write_file(deps, str(target), "new")
    assert out == {"bytes_written": 3}
    assert target.read_text(encoding="utf-8") == "new"


def test_write_file_refused_when_read_only(tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    deps = ToolDeps(sandbox=Sandbox.create([str(root)]), read_only=True, max_bytes=1024)
    with pytest.raises(WriteForbiddenError):
        write_file(deps, str(root / "new.txt"), "hello")


def test_write_file_refuses_content_over_cap(deps: ToolDeps, tmp_path: Path):
    target = tmp_path / "root" / "big.txt"
    with pytest.raises(FileTooLargeError):
        write_file(deps, str(target), "x" * 2000)


def test_write_file_propagates_sandbox_escape(deps: ToolDeps, tmp_path: Path):
    outsider = tmp_path / "elsewhere"
    outsider.mkdir()
    with pytest.raises(SandboxEscape):
        write_file(deps, str(outsider / "new.txt"), "nope")


# --- config integration sanity ---


def test_tooldeps_default_max_bytes_is_one_mib(tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    deps = ToolDeps(sandbox=Sandbox.create([str(root)]))
    assert deps.max_bytes == 1_048_576
    assert deps.read_only is False
