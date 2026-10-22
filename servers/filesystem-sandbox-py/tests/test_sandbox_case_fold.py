"""On a case-insensitive darwin volume, ``resolve`` returns the on-disk name, as the TS port does (#298).

macOS's default APFS is case- and normalization-insensitive. The TS port's
``fs.realpath`` calls libc ``realpath(3)``, which returns each component's
ON-DISK name; ``os.path.realpath`` kept them as typed, and containment is a
string comparison. With root ``Root/``, TS resolved ``root/f.txt`` to
``Root/f.txt`` and this port refused it, and ``Root/F.TXT`` came back here as
``F.TXT`` -- a "resolved" path that is not the file's name.

CI runs on case-sensitive ubuntu, where the aliases do not exist, so the
darwin cases skip there; ``servers/filesystem-sandbox/test/sandbox-case-fold.test.ts``
pins the same expectations on the TS side. The fallback and off-darwin tests
run everywhere.
"""

from __future__ import annotations

import os
import sys
import unicodedata
from pathlib import Path

import pytest

from filesystem_sandbox import sandbox as sandbox_mod
from filesystem_sandbox.sandbox import Sandbox, SandboxEscape

# On disk in NFD (`e` + U+0301); requested below in NFC (U+00E9).
NFD_NAME = unicodedata.normalize("NFD", "é.txt")
NFC_NAME = unicodedata.normalize("NFC", "é.txt")


@pytest.fixture
def base(tmp_path: Path) -> Path:
    b = Path(os.path.realpath(tmp_path))
    root = b / "Root"
    (root / "Sub").mkdir(parents=True)
    (root / "f.txt").write_text("f", encoding="utf-8")
    os.link(root / "f.txt", root / "g.txt")
    (root / NFD_NAME).write_text("e", encoding="utf-8")
    # A symlink whose target is spelled in another case than the file.
    os.symlink("F.TXT", root / "flink")
    (b / "Other").mkdir()
    (b / "Other" / "secret.txt").write_text("s", encoding="utf-8")
    (b / "RootX").mkdir()
    (b / "RootX" / "f.txt").write_text("x", encoding="utf-8")
    if sys.platform != "darwin" or not os.path.exists(b / "root"):
        pytest.skip("needs a case-insensitive darwin volume (#298)")
    return b


def _p(base: Path, rel: str) -> str:
    return str(base) + os.sep + rel


# --- red against the pre-#298 port -------------------------------------------


def test_a_case_alias_of_the_root_resolves_to_the_on_disk_root(base: Path) -> None:
    sb = Sandbox.create([_p(base, "Root")])
    assert sb.resolve(_p(base, "root/f.txt")).resolved == _p(base, "Root/f.txt")


def test_a_case_alias_of_the_leaf_resolves_to_the_on_disk_name(base: Path) -> None:
    sb = Sandbox.create([_p(base, "Root")])
    assert sb.resolve(_p(base, "Root/F.TXT")).resolved == _p(base, "Root/f.txt")


def test_a_root_spelled_in_another_case_is_published_as_it_is_on_disk(base: Path) -> None:
    sb = Sandbox.create([_p(base, "root")])
    assert sb.allowed_roots == (_p(base, "Root/"),)
    # The correctly-cased path used to be refused against a `root/` root.
    assert sb.resolve(_p(base, "Root/f.txt")).resolved == _p(base, "Root/f.txt")


def test_a_hardlink_alias_resolves_to_its_own_name_not_its_twin(base: Path) -> None:
    sb = Sandbox.create([_p(base, "Root")])
    assert sb.resolve(_p(base, "Root/G.TXT")).resolved == _p(base, "Root/g.txt")


def test_a_normalization_alias_resolves_to_the_on_disk_form(base: Path) -> None:
    sb = Sandbox.create([_p(base, "Root")])
    assert sb.resolve(_p(base, "ROOT/" + NFC_NAME)).resolved == _p(base, "Root/" + NFD_NAME)


def test_a_write_under_a_case_aliased_parent_lands_in_the_on_disk_parent(base: Path) -> None:
    sb = Sandbox.create([_p(base, "Root")])
    got = sb.resolve(_p(base, "root/sub/new.txt"), must_exist=False).resolved
    assert got == _p(base, "Root/Sub/new.txt")


def test_a_write_through_a_leaf_symlink_resolves_its_target_to_the_on_disk_name(base: Path) -> None:
    sb = Sandbox.create([_p(base, "Root")])
    got = sb.resolve(_p(base, "Root/flink"), must_exist=False).resolved
    assert got == _p(base, "Root/f.txt")


def test_resolve_dir_through_a_case_alias(base: Path) -> None:
    sb = Sandbox.create([_p(base, "Root")])
    assert sb.resolve_dir(_p(base, "root/sub")).resolved == _p(base, "Root/Sub")


# --- controls: green before and after ----------------------------------------


def test_exact_case_paths_are_unchanged(base: Path) -> None:
    sb = Sandbox.create([_p(base, "Root")])
    assert sb.allowed_roots == (_p(base, "Root/"),)
    assert sb.resolve(_p(base, "Root/f.txt")).resolved == _p(base, "Root/f.txt")


@pytest.mark.parametrize(
    "rel", ["other/secret.txt", "OTHER/secret.txt", "rootx/f.txt", "ROOTX/f.txt"]
)
def test_a_case_alias_outside_the_root_is_still_refused(base: Path, rel: str) -> None:
    sb = Sandbox.create([_p(base, "Root")])
    with pytest.raises(SandboxEscape) as exc:
        sb.resolve(_p(base, rel))
    assert exc.value.reason == "outside_allowlist"


def test_a_write_leaf_keeps_the_case_it_was_given(base: Path) -> None:
    # Both ports realpath only the PARENT of a write target that is not a
    # symlink, so the leaf stays as typed in TS too. Pinned so a fix here does
    # not drift from TS on the write branch while closing the read one.
    sb = Sandbox.create([_p(base, "Root")])
    got = sb.resolve(_p(base, "Root/F.TXT"), must_exist=False).resolved
    assert got == _p(base, "Root/F.TXT")


# --- everywhere ----------------------------------------------------------------


def test_realpath_falls_back_to_os_realpath_when_libc_refuses(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sandbox_mod, "_DARWIN_REALPATH", lambda _p, _buf: None)
    assert sandbox_mod._realpath(str(tmp_path)) == os.path.realpath(tmp_path)


@pytest.mark.skipif(sys.platform == "darwin", reason="off-darwin behaviour")
def test_off_darwin_resolution_is_os_realpath() -> None:
    # Linux keeps the case-preserving `os.path.realpath`, which already agrees
    # with the glibc `realpath` the TS port calls there.
    assert sandbox_mod._DARWIN_REALPATH is None
