"""write_file refuses a directory target, the allow-list root included (#238).

Parity with the TS twin's `test/write-to-directory.test.ts`. `resolve` accepts
the root itself, and `atomic_write_bytes` stages its temp file in the target's
PARENT -- for the root, outside the sandbox -- so the caller's bytes were
written there before `os.replace` failed (`[Errno 21] Is a directory`).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from filesystem_sandbox.sandbox import Sandbox, SandboxEscape
from filesystem_sandbox.tools import ToolDeps, write_file


@pytest.fixture
def layout(tmp_path: Path) -> tuple[Path, Path, ToolDeps]:
    parent = Path(os.path.realpath(tmp_path))
    root = parent / "root"
    (root / "sub").mkdir(parents=True)
    return parent, root, ToolDeps(sandbox=Sandbox.create([str(root)]), max_bytes=1024)


@pytest.mark.parametrize("suffix", ["", "/.", "/", "/sub/.."])
def test_the_root_itself_is_refused_and_nothing_lands_outside_it(layout, suffix: str) -> None:
    parent, root, deps = layout
    with pytest.raises(SandboxEscape) as exc:
        write_file(deps, str(root) + suffix, "secret")
    assert exc.value.reason == "not_a_file"
    assert sorted(os.listdir(parent)) == ["root"]


def test_a_subdirectory_is_refused_the_same_way(layout) -> None:
    _parent, root, deps = layout
    with pytest.raises(SandboxEscape) as exc:
        write_file(deps, str(root / "sub"), "x")
    assert exc.value.reason == "not_a_file"
    assert os.listdir(root / "sub") == []


def test_a_new_and_an_existing_file_are_still_written(layout) -> None:
    _parent, root, deps = layout
    write_file(deps, str(root / "a.txt"), "one")
    write_file(deps, str(root / "a.txt"), "two")
    assert (root / "a.txt").read_text() == "two"
