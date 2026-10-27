"""A path component swapped for a symlink AFTER the sandbox check (#233).

Parity with the TS twin's ``test/symlink-swap-race.test.ts``. ``resolve``
realpath's the input and checks containment; the tools then did their IO by
path, and the kernel followed whatever the path named by then. The race is made
deterministic here: the sandbox below performs the swap the moment
``resolve*`` returns, the worst-case interleaving, and every tool must then
refuse without touching the outside directory.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import threading
from collections.abc import Callable
from pathlib import Path

import pytest

from filesystem_sandbox.sandbox import Sandbox, SandboxEscape
from filesystem_sandbox.tools import ToolDeps, list_directory, read_file, write_file

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlink/FIFO semantics")


class _Racing:
    """A sandbox whose every ``resolve*`` runs ``after`` before returning."""

    def __init__(self, real: Sandbox, after: Callable[[], None]) -> None:
        self._real = real
        self._after = after

    def __getattr__(self, name: str):
        value = getattr(self._real, name)
        if not callable(value):
            return value

        def wrapped(*args, **kwargs):
            result = value(*args, **kwargs)
            self._after()
            return result

        return wrapped


@pytest.fixture
def tree(tmp_path: Path):
    base = Path(os.path.realpath(tmp_path))
    root, out = base / "root", base / "out"
    (root / "realsub" / "deeper").mkdir(parents=True)
    (out / "deeper").mkdir(parents=True)
    (root / "realsub" / "f.txt").write_text("inside")
    (root / "realsub" / "deeper" / "f.txt").write_text("inside")
    (out / "f.txt").write_text("SECRET-OUTSIDE")
    (out / "deeper" / "f.txt").write_text("SECRET-OUTSIDE")
    yield base, root, out, Sandbox.create([str(root)])
    os.chmod(root / "realsub", 0o755)


def _swap_for_symlink(root: Path, rel: str, target: Path) -> None:
    os.rename(root / rel, root / f"{rel}.moved")
    os.symlink(target, root / rel)


def _deps(sandbox) -> ToolDeps:
    return ToolDeps(sandbox=sandbox, read_only=False, max_bytes=1_000_000)


def _outside(out: Path) -> str:
    return json.dumps([sorted(os.listdir(out)), (out / "f.txt").read_text()])


def _racing_parent(tree) -> ToolDeps:
    _base, root, out, sandbox = tree
    return _deps(_Racing(sandbox, lambda: _swap_for_symlink(root, "realsub", out)))


# -- a parent directory swapped -------------------------------------------------


def test_read_file_refuses_instead_of_returning_the_outside_file(tree) -> None:
    root = tree[1]
    with pytest.raises(SandboxEscape) as exc:
        read_file(_racing_parent(tree), str(root / "realsub" / "f.txt"))
    assert exc.value.reason == "outside_allowlist"


def test_list_directory_refuses_instead_of_listing_the_outside_directory(tree) -> None:
    root = tree[1]
    with pytest.raises(SandboxEscape) as exc:
        list_directory(_racing_parent(tree), str(root / "realsub"))
    assert exc.value.reason == "outside_allowlist"


@pytest.mark.parametrize("name", ["f.txt", "new.txt"])
def test_write_file_refuses_and_leaves_the_outside_directory_untouched(tree, name: str) -> None:
    root, out = tree[1], tree[2]
    before = _outside(out)
    with pytest.raises(SandboxEscape) as exc:
        write_file(_racing_parent(tree), str(root / "realsub" / name), "PWNED")
    assert exc.value.reason == "outside_allowlist"
    assert _outside(out) == before


def test_a_swap_two_levels_up_is_refused_too(tree) -> None:
    root = tree[1]
    with pytest.raises(SandboxEscape) as exc:
        read_file(_racing_parent(tree), str(root / "realsub" / "deeper" / "f.txt"))
    assert exc.value.reason == "outside_allowlist"


# -- the leaf swapped ------------------------------------------------------------


def test_read_file_refuses_a_leaf_swapped_for_a_symlink(tree) -> None:
    _base, root, out, sandbox = tree
    deps = _deps(_Racing(sandbox, lambda: _swap_for_symlink(root, "realsub/f.txt", out / "f.txt")))
    with pytest.raises(SandboxEscape) as exc:
        read_file(deps, str(root / "realsub" / "f.txt"))
    assert exc.value.reason == "outside_allowlist"


def test_write_file_replaces_a_swapped_leaf_symlink_rather_than_writing_through_it(tree) -> None:
    _base, root, out, sandbox = tree
    before = _outside(out)
    deps = _deps(_Racing(sandbox, lambda: _swap_for_symlink(root, "realsub/f.txt", out / "f.txt")))
    write_file(deps, str(root / "realsub" / "f.txt"), "new")
    assert _outside(out) == before
    leaf = root / "realsub" / "f.txt"
    assert leaf.is_file()
    assert not leaf.is_symlink()
    assert leaf.read_text() == "new"


def test_read_file_refuses_a_leaf_swapped_for_a_fifo_without_blocking(tree) -> None:
    _base, root, _out, sandbox = tree
    leaf = root / "realsub" / "f.txt"

    def swap() -> None:
        leaf.unlink()
        os.mkfifo(leaf)

    # Watchdog: a reader blocked in `open` is released by a writer opening the
    # FIFO, so an unfixed read fails this arm instead of hanging the run.
    def release() -> None:
        with contextlib.suppress(OSError):
            os.close(os.open(leaf, os.O_WRONLY | os.O_NONBLOCK))

    watchdog = threading.Timer(2.0, release)
    watchdog.start()
    try:
        with pytest.raises(SandboxEscape) as exc:
            read_file(_deps(_Racing(sandbox, swap)), str(leaf))
    finally:
        watchdog.cancel()
    assert exc.value.reason == "not_a_file"


# -- controls --------------------------------------------------------------------


def test_read_list_and_write_work_under_a_symlinked_root(tree) -> None:
    base, root = tree[0], tree[1]
    link = base / "root-link"
    os.symlink(root, link)
    deps = _deps(Sandbox.create([str(link)]))
    write_file(deps, str(link / "realsub" / "g.txt"), "via link")
    assert read_file(deps, str(link / "realsub" / "g.txt")) == "via link"
    names = [e.name for e in list_directory(deps, str(link / "realsub"))]
    assert names == ["deeper", "f.txt", "g.txt"]


def test_write_file_through_an_in_root_symlinked_leaf_writes_its_target(tree) -> None:
    _base, root, _out, sandbox = tree
    os.symlink(root / "realsub" / "f.txt", root / "alias.txt")
    write_file(_deps(sandbox), str(root / "alias.txt"), "via alias")
    assert (root / "realsub" / "f.txt").read_text() == "via alias"


def test_read_file_through_an_in_root_symlinked_directory_reads_the_real_file(tree) -> None:
    _base, root, _out, sandbox = tree
    os.symlink(root / "realsub", root / "alias")
    assert read_file(_deps(sandbox), str(root / "alias" / "f.txt")) == "inside"


# Root ignores permission bits, so the arm would prove nothing as root.
@pytest.mark.skipif(hasattr(os, "getuid") and os.getuid() == 0, reason="root bypasses mode bits")
def test_a_search_only_directory_on_the_way_still_reads_and_writes(tree) -> None:
    _base, root, _out, sandbox = tree
    os.chmod(root / "realsub", 0o311)
    deps = _deps(sandbox)
    assert read_file(deps, str(root / "realsub" / "deeper" / "f.txt")) == "inside"
    write_file(deps, str(root / "realsub" / "new.txt"), "x")
    os.chmod(root / "realsub", 0o755)
    assert (root / "realsub" / "new.txt").read_text() == "x"
