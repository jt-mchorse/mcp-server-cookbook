"""``Sandbox.create`` refuses a root that is not a directory, as the TS port does (#198).

``create``'s docstring says "Each root must exist and be a directory" and both
ports accepted a regular file. The rows live in
``test-fixtures/root_kind_parity.json`` and the TS suite reads the same file, so
the two ports are held to literally the same expectations.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from filesystem_sandbox.sandbox import Sandbox, SandboxEscape

TABLE_PATH = Path(__file__).resolve().parents[3] / "test-fixtures" / "root_kind_parity.json"
TABLE = json.loads(TABLE_PATH.read_text(encoding="utf-8"))


def _build_tree(base: Path) -> None:
    for d in TABLE["tree"]["dirs"]:
        (base / d).mkdir(parents=True, exist_ok=True)
    for rel, content in TABLE["tree"]["files"].items():
        (base / rel).write_text(content, encoding="utf-8")
    for link in TABLE["tree"]["symlinks"]:
        os.symlink(str(base / link["target"]), str(base / link["link"]))


def test_the_table_covers_every_root_kind_and_both_outcomes() -> None:
    reasons = {c.get("reason") for c in TABLE["cases"] if c["expect"] == "escape"}
    assert reasons == {"root_not_a_directory", "root_does_not_exist"}
    assert sum(c["expect"] == "ok" for c in TABLE["cases"]) == 2


@pytest.mark.parametrize("case", TABLE["cases"], ids=[c["label"] for c in TABLE["cases"]])
def test_create_matches_the_shared_table(case: dict, tmp_path: Path) -> None:
    _build_tree(tmp_path)
    root = str(tmp_path / case["root"])
    if case["expect"] == "ok":
        sb = Sandbox.create([root])
        expected = os.path.realpath(str(tmp_path / case["resolved"])) + os.sep
        assert sb.allowed_roots == (expected,)
    else:
        with pytest.raises(SandboxEscape) as ei:
            Sandbox.create([root])
        assert ei.value.reason == case["reason"]
        assert ei.value.input == root


def test_a_file_root_is_refused_even_beside_a_valid_one(tmp_path: Path) -> None:
    # Every root is checked, not only the first.
    _build_tree(tmp_path)
    with pytest.raises(SandboxEscape) as ei:
        Sandbox.create([str(tmp_path / "dir"), str(tmp_path / "file.txt")])
    assert ei.value.reason == "root_not_a_directory"
