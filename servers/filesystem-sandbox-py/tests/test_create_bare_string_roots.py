"""``Sandbox.create`` refuses a bare string for ``roots`` (#205).

A ``str`` is iterable, so ``create("/a")`` walked ``"/"`` and then ``"a"``
against the current directory. When ``a`` existed there the allow-list was
``("/", ".../a/")`` and ``resolve("/etc/hosts")`` was allowed -- the sandbox
disabled by one missing pair of brackets. The shipped server is unaffected (its
config loader hands ``create`` a list); the exported library class was not.
The TS suite runs the same repro.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from filesystem_sandbox import Sandbox


@pytest.fixture
def cwd_with_a(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    (tmp_path / "a").mkdir()
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.mark.parametrize("bare", ["/a", b"/a", bytearray(b"/a"), "..", ""])
def test_a_bare_string_is_refused_before_any_root_is_resolved(bare: Any, cwd_with_a: Path) -> None:
    with pytest.raises(ValueError, match="would be read one character at a time") as exc:
        Sandbox.create(bare)
    assert repr(bare) in str(exc.value)


def test_the_message_shows_the_working_spelling(cwd_with_a: Path) -> None:
    with pytest.raises(ValueError, match=r"pass \['/a'\]"):
        Sandbox.create("/a")


def test_the_working_spelling_never_puts_the_filesystem_root_on_the_allow_list(
    cwd_with_a: Path,
) -> None:
    sb = Sandbox.create([str(cwd_with_a / "a")])
    assert sb.allowed_roots == (os.path.realpath(str(cwd_with_a / "a")) + os.sep,)
    assert os.sep not in sb.allowed_roots


@pytest.mark.parametrize("container", [list, tuple], ids=["list", "tuple"])
def test_list_and_tuple_roots_are_unchanged(container: Any, tmp_path: Path) -> None:
    (tmp_path / "x").mkdir()
    (tmp_path / "y").mkdir()
    roots = container([str(tmp_path / "x"), str(tmp_path / "y")])
    assert len(Sandbox.create(roots).allowed_roots) == 2
