"""``Sandbox.resolve`` parity with the TypeScript port (#141).

Three parity fixes preceded this one — #98 (grammar), #137 (value domain),
#139 (trim charset) — and **all three landed in ``config``**. ``sandbox``,
where the security property actually lives, had never been probed side by side,
and the test suite showed the same gap: a ``config-trim-parity`` pair and a
``max-bytes-parity`` pair, no sandbox pair.

Running one identical case table through both ports found 3 divergences in 15
cases. None was an allow-list escape — containment held everywhere — but all
three were contract disagreements in an exported API:

1. A **dangling symlink pointing inside a root** was accepted here under
   ``must_exist=True``, because ``os.path.lexists`` does not follow symlinks.
   ``resolve`` returned a path for which ``os.path.exists`` is ``False``. This
   is the ``must_exist=True`` sibling of #60, whose ``must_exist=False`` branch
   *is* covered in both ports.
2. A path whose **parent is a regular file** was accepted by TS, because
   ``fs.realpath`` succeeds on a file.
3. A **trailing separator on a file** was rejected by both, but for different
   reasons and by accident.

The table lives in ``test-fixtures/sandbox_parity.json`` and is read by BOTH
suites, so the ports are exercised against literally the same inputs rather
than two hand-maintained copies that can drift apart the way the
implementations did.

Every row asserts the **resolved path** on accept and the **reason** on
reject, not just accept/reject — the trailing-separator row passes an
accept/reject-only check on the broken tree, because both ports rejected it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from filesystem_sandbox.sandbox import Sandbox, SandboxEscape

TABLE_PATH = Path(__file__).resolve().parents[3] / "test-fixtures" / "sandbox_parity.json"
TABLE = json.loads(TABLE_PATH.read_text(encoding="utf-8"))


def _build_tree(base: Path) -> None:
    """Materialize the shared fixture tree under `base`."""
    for d in TABLE["tree"]["dirs"]:
        (base / d).mkdir(parents=True, exist_ok=True)
    for rel, content in TABLE["tree"]["files"].items():
        (base / rel).write_text(content, encoding="utf-8")
    for link in TABLE["tree"]["symlinks"]:
        os.symlink(str(base / link["target"]), str(base / link["link"]))


def _input_for(case: dict, base: Path) -> str:
    """Turn a fixture `path` into the string handed to `resolve`.

    Two escapes keep the shared table language-neutral: `!literal:` passes the
    remainder through untouched (for the empty-input row), and `!relative:`
    marks a deliberately relative path. Everything else is joined onto the
    per-run temp base.
    """
    raw = case["path"]
    if raw.startswith("!literal:"):
        return raw[len("!literal:") :]
    if raw.startswith("!relative:"):
        return raw[len("!relative:") :]
    # Deliberate string concatenation, NOT `base / raw`: `pathlib` strips a
    # trailing separator when it constructs a Path, so the "trailing separator
    # on a file" row silently lost the very character it exists to test and
    # passed. Caught by that row failing with DID NOT RAISE.
    return str(base).rstrip(os.sep) + os.sep + raw


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    base = Path(os.path.realpath(tmp_path))
    _build_tree(base)
    return base


@pytest.fixture
def sandbox(tree: Path) -> Sandbox:
    return Sandbox.create([str(tree / r) for r in TABLE["allowlist"]])


def test_the_table_is_not_empty() -> None:
    # Guards the guard: a fixture that failed to load would make every
    # parametrized case vanish and the suite would look green.
    assert len(TABLE["cases"]) >= 15


@pytest.mark.parametrize("case", TABLE["cases"], ids=lambda c: c["label"])
def test_resolve_matches_the_shared_parity_table(case: dict, sandbox: Sandbox, tree: Path) -> None:
    target = _input_for(case, tree)
    if case["expect"] == "ok":
        sp = sandbox.resolve(target, must_exist=case["must_exist"])
        assert sp.resolved == str(tree / case["resolved"]), case.get("note", "")
    else:
        with pytest.raises(SandboxEscape) as exc:
            sandbox.resolve(target, must_exist=case["must_exist"])
        assert exc.value.reason == case["reason"], case.get("note", "")


def test_must_exist_true_never_returns_a_nonexistent_path(sandbox: Sandbox, tree: Path) -> None:
    """The contract `must_exist` is named for (#141, divergence 1).

    Stated as a property rather than a case, because the specific input that
    broke it — a dangling symlink — is not the only way to reach it.
    """
    for case in TABLE["cases"]:
        if not case["must_exist"] or case["expect"] != "ok":
            continue
        sp = sandbox.resolve(_input_for(case, tree), must_exist=True)
        assert os.path.exists(sp.resolved), (
            f"{case['label']}: resolve(must_exist=True) returned {sp.resolved!r}, "
            "which does not exist"
        )


def test_containment_still_holds_for_every_rejecting_case(sandbox: Sandbox, tree: Path) -> None:
    """None of the #141 fixes weakened the allow-list.

    Anything the table rejects must stay rejected, and nothing outside the root
    may be reachable — the property the threat model actually promises, as
    distinct from the contract parity this file is mostly about.
    """
    outside = str(tree / "outside" / "secret.txt")
    with pytest.raises(SandboxEscape):
        sandbox.resolve(outside, must_exist=True)
    with pytest.raises(SandboxEscape):
        sandbox.resolve(outside, must_exist=False)
