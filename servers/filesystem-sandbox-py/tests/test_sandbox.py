"""Security invariants for the sandbox layer.

Mirrors the TypeScript suite in ``../filesystem-sandbox/test/sandbox.test.ts``.
Every test pins a property that the TS suite also pins, so the two
implementations are *behaviorally* parity-tested, not just type-tested.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Allow ``pytest`` from the repo root to import the package without
# installing it. The console script entry uses the installed form.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from filesystem_sandbox.sandbox import Sandbox, SandboxEscape  # noqa: E402


@pytest.fixture
def sandbox(tmp_path: Path) -> Sandbox:
    """Two-root sandbox over freshly-minted tmp directories."""
    a = tmp_path / "root_a"
    b = tmp_path / "root_b"
    a.mkdir()
    b.mkdir()
    return Sandbox.create([str(a), str(b)])


# --- construction ---


def test_create_requires_at_least_one_root():
    with pytest.raises(ValueError, match="at least one"):
        Sandbox.create([])


def test_create_resolves_symlinked_roots(tmp_path: Path):
    target = tmp_path / "target"
    target.mkdir()
    link = tmp_path / "link"
    link.symlink_to(target)
    sb = Sandbox.create([str(link)])
    # The resolved root carries the canonical target's realpath, not
    # the symlink's literal path. realpath also resolves the tmp_path
    # prefix on macOS (/var -> /private/var), so compare via realpath.
    expected = os.path.realpath(str(target)) + os.sep
    assert expected in sb.allowed_roots


def test_create_rejects_nonexistent_root(tmp_path: Path):
    with pytest.raises(SandboxEscape) as ei:
        Sandbox.create([str(tmp_path / "does_not_exist")])
    assert ei.value.reason == "root_does_not_exist"


# --- input validation ---


def test_resolve_rejects_empty_path(sandbox: Sandbox):
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve("")
    assert ei.value.reason == "input_empty"


def test_resolve_rejects_null_byte(sandbox: Sandbox):
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve("/tmp/foo\0bar")
    assert ei.value.reason == "input_null_byte"


@pytest.mark.parametrize("ch", ["\x01", "\x09", "\x0a", "\x1f", "\x7f"])
def test_resolve_rejects_control_characters(sandbox: Sandbox, ch: str):
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve(f"/tmp/foo{ch}bar")
    assert ei.value.reason == "input_control_char"


def test_resolve_rejects_relative_path(sandbox: Sandbox):
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve("relative/path.txt")
    assert ei.value.reason == "input_relative_disallowed"


# --- allow-list enforcement ---


def test_resolve_accepts_path_inside_root(sandbox: Sandbox, tmp_path: Path):
    f = tmp_path / "root_a" / "x.txt"
    f.write_text("hello", encoding="utf-8")
    sp = sandbox.resolve(str(f))
    assert sp.resolved == os.path.realpath(str(f))


def test_resolve_rejects_path_outside_any_root(sandbox: Sandbox, tmp_path: Path):
    outsider = tmp_path / "elsewhere"
    outsider.mkdir()
    target = outsider / "x.txt"
    target.write_text("nope", encoding="utf-8")
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve(str(target))
    assert ei.value.reason == "outside_allowlist"


def test_resolve_rejects_path_traversal(sandbox: Sandbox, tmp_path: Path):
    # /root_a/../elsewhere/x.txt — Python's realpath collapses ../
    # and lands outside the allow-list.
    outsider = tmp_path / "elsewhere"
    outsider.mkdir()
    target = outsider / "x.txt"
    target.write_text("nope", encoding="utf-8")
    sneaky = str(tmp_path / "root_a" / ".." / "elsewhere" / "x.txt")
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve(sneaky)
    assert ei.value.reason == "outside_allowlist"


def test_resolve_rejects_symlink_outside_allowlist(sandbox: Sandbox, tmp_path: Path):
    outsider = tmp_path / "elsewhere"
    outsider.mkdir()
    secret = outsider / "secret.txt"
    secret.write_text("classified", encoding="utf-8")
    # A symlink *inside* root_a pointing *outside* must not succeed.
    link = tmp_path / "root_a" / "link_to_secret"
    link.symlink_to(secret)
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve(str(link))
    assert ei.value.reason == "outside_allowlist"


def test_resolve_prefix_match_does_not_overlap_sibling(
    tmp_path: Path,
):
    # /tmp/foo must not match /tmp/foobar via substring.
    foo = tmp_path / "foo"
    foo.mkdir()
    foobar = tmp_path / "foobar"
    foobar.mkdir()
    target = foobar / "x.txt"
    target.write_text("nope", encoding="utf-8")
    sb = Sandbox.create([str(foo)])
    with pytest.raises(SandboxEscape) as ei:
        sb.resolve(str(target))
    assert ei.value.reason == "outside_allowlist"


def test_resolve_accepts_exact_root_path(sandbox: Sandbox, tmp_path: Path):
    root_a = tmp_path / "root_a"
    sp = sandbox.resolve(str(root_a))
    assert sp.resolved == os.path.realpath(str(root_a))


# --- must_exist=False (writes to a new file) ---


def test_resolve_must_exist_false_accepts_nonexistent_leaf(sandbox: Sandbox, tmp_path: Path):
    new_file = tmp_path / "root_a" / "not_yet_created.txt"
    sp = sandbox.resolve(str(new_file), must_exist=False)
    assert sp.resolved == os.path.join(
        os.path.realpath(str(tmp_path / "root_a")), "not_yet_created.txt"
    )


def test_resolve_must_exist_false_still_rejects_outside_allowlist(sandbox: Sandbox, tmp_path: Path):
    outsider = tmp_path / "elsewhere"
    outsider.mkdir()
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve(str(outsider / "new.txt"), must_exist=False)
    assert ei.value.reason == "outside_allowlist"


def test_resolve_must_exist_false_rejects_nonexistent_parent(sandbox: Sandbox, tmp_path: Path):
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve(
            str(tmp_path / "root_a" / "does_not_exist" / "x.txt"),
            must_exist=False,
        )
    assert ei.value.reason == "outside_allowlist"


# --- resolve_dir / resolve_file convenience ---


def test_resolve_dir_rejects_files(sandbox: Sandbox, tmp_path: Path):
    f = tmp_path / "root_a" / "x.txt"
    f.write_text("hi", encoding="utf-8")
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve_dir(str(f))
    assert ei.value.reason == "not_a_directory"


def test_resolve_file_rejects_directories(sandbox: Sandbox, tmp_path: Path):
    with pytest.raises(SandboxEscape) as ei:
        sandbox.resolve_file(str(tmp_path / "root_a"))
    assert ei.value.reason == "not_a_file"
