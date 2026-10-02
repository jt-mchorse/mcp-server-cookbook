"""Content and listing parity with the TS port (#209).

Rows live in ``test-fixtures/content_parity.json``; the TS suite reads the same
file. Python already behaved this way -- the table pins it, so the two ports
cannot drift apart again. Writes go through ``_dispatch_tool``, so the error is
compared as the text a client receives.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from filesystem_sandbox.sandbox import Sandbox
from filesystem_sandbox.server import _dispatch_tool
from filesystem_sandbox.tools import ToolDeps, list_directory, read_file

TABLE = json.loads(
    (Path(__file__).resolve().parents[3] / "test-fixtures" / "content_parity.json").read_text(
        encoding="utf-8"
    )
)


@pytest.fixture
def deps(tmp_path: Path) -> ToolDeps:
    return ToolDeps(sandbox=Sandbox.create([os.path.realpath(tmp_path)]), max_bytes=1 << 20)


@pytest.mark.parametrize(
    "case", TABLE["write_cases"], ids=[c["label"] for c in TABLE["write_cases"]]
)
def test_write_file(case: dict, deps: ToolDeps, tmp_path: Path) -> None:
    target = os.path.join(os.path.realpath(tmp_path), "out.txt")
    text, is_error = _dispatch_tool(
        "write_file", {"path": target, "content": case["content"]}, deps
    )
    if "error" in case:
        assert is_error
        assert text == case["error"]
        assert not os.path.exists(target)
    else:
        assert not is_error
        assert json.loads(text) == {"bytes_written": case["bytes_written"]}


@pytest.mark.parametrize("case", TABLE["read_cases"], ids=[c["label"] for c in TABLE["read_cases"]])
def test_read_file(case: dict, deps: ToolDeps, tmp_path: Path) -> None:
    target = os.path.join(os.path.realpath(tmp_path), "in.txt")
    Path(target).write_bytes(bytes.fromhex(case["bytes_hex"]))
    assert read_file(deps, target) == case["text"]


def test_list_directory_orders_by_code_point(deps: ToolDeps, tmp_path: Path) -> None:
    root = os.path.realpath(tmp_path)
    for name in TABLE["list_names"]:
        Path(root, name).write_text("")
    assert [e.name for e in list_directory(deps, root)] == TABLE["list_order"]
