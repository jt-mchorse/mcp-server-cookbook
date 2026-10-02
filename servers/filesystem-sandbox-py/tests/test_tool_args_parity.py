"""The Python port refuses the same tool arguments, for the same reason, as the
TS port (#197, D-014).

The Python SDK validates every call against the tool's published
``inputSchema`` with jsonschema before the handler runs. The TS SDK does not,
so until #197 the TS port enforced none of its schema: ``read_file`` with an
extra ``max_bytes`` returned the whole file, and ``{path: 5}`` was refused as
``sandbox_escape (input_empty)``. The TS port now runs ``checkToolArgs``; this
side runs the table through jsonschema -- what the SDK runs -- against this
port's ``_build_tool_specs()``, so the two are held to one table
(``test-fixtures/tool_args_parity.json``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

jsonschema = pytest.importorskip("jsonschema")

from filesystem_sandbox.server import _build_tool_specs  # noqa: E402

TABLE = Path(__file__).resolve().parents[3] / "test-fixtures" / "tool_args_parity.json"
CASES: list[dict[str, Any]] = json.loads(TABLE.read_text(encoding="utf-8"))["cases"]
SCHEMAS = {spec["name"]: spec["inputSchema"] for spec in _build_tool_specs()}


def test_the_table_and_the_schemas_are_both_non_empty() -> None:
    assert sorted(SCHEMAS) == ["list_directory", "read_file", "write_file"]
    assert len(CASES) >= 10


@pytest.mark.parametrize("case", CASES, ids=[c["label"] for c in CASES])
def test_jsonschema_gives_the_tables_verdict(case: dict[str, Any]) -> None:
    errors = list(jsonschema.Draft202012Validator(SCHEMAS[case["tool"]]).iter_errors(case["args"]))
    if case["fragment"] is None:
        assert errors == []
    else:
        # One violation per row, by the table's construction, so the message
        # the SDK prints is this one.
        assert len(errors) == 1, [e.message for e in errors]
        assert case["fragment"] in errors[0].message
