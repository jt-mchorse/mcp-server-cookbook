"""The two filesystem-sandbox ports publish the same tool STRUCTURE (#189).

The README claimed "identical tool schemas" and a "byte-identical" MCP
interchange. Measured with `tools/list` against both ports: names, property
names and types, `required` and `additionalProperties` match; every tool
description and every property description differs, because each port words
its own. And the docstring on `_build_tool_specs` said drift would be caught by
the spec-version check, which compares `@modelcontextprotocol/sdk` pins and
never reads a schema. Nothing checked this.

The TS side is read from source because its server starts a transport on
import. The parse is small and pinned by a floor and a negative arm.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

from filesystem_sandbox import __version__
from filesystem_sandbox.server import _build_tool_specs

TS_SERVER = Path(__file__).resolve().parents[2] / "filesystem-sandbox" / "src" / "server.ts"


def ts_tool_structure(source: str) -> dict[str, dict[str, Any]]:
    """`TOOLS` in the TS server, reduced to structure: no descriptions."""
    start = source.index("const TOOLS = [")
    end = source.index("\n];", start)
    body = source[start:end]
    tools: dict[str, dict[str, Any]] = {}
    for block in re.split(r"\n  \{\n", body)[1:]:
        name = re.search(r'^\s*name: "(\w+)"', block, re.M)
        assert name, block
        props = dict(re.findall(r'^\s{8}(\w+): \{ type: "(\w+)"', block, re.M))
        required = re.search(r"required: \[([^\]]*)\]", block)
        additional = re.search(r"additionalProperties: (true|false)", block)
        tools[name.group(1)] = {
            "properties": props,
            "required": re.findall(r'"(\w+)"', required.group(1)) if required else [],
            "additionalProperties": additional.group(1) == "true" if additional else None,
        }
    return tools


def py_tool_structure() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for spec in _build_tool_specs():
        schema = spec["inputSchema"]
        out[spec["name"]] = {
            "properties": {k: v["type"] for k, v in schema["properties"].items()},
            "required": list(schema.get("required", [])),
            "additionalProperties": schema.get("additionalProperties"),
        }
    return out


def test_the_ts_parse_finds_every_tool() -> None:
    # A floor on the parse, so a reformat of the TS source cannot make the
    # comparison below pass on two empty dicts.
    ts = ts_tool_structure(TS_SERVER.read_text(encoding="utf-8"))
    assert sorted(ts) == ["list_directory", "read_file", "write_file"]
    assert ts["write_file"]["properties"] == {"path": "string", "content": "string"}


def test_both_ports_publish_the_same_structure() -> None:
    ts = ts_tool_structure(TS_SERVER.read_text(encoding="utf-8"))
    assert py_tool_structure() == ts


def test_a_property_on_one_port_only_is_caught() -> None:
    source = TS_SERVER.read_text(encoding="utf-8")
    anchor = '        content: { type: "string", description: "UTF-8 text contents." },\n'
    assert anchor in source
    drifted = source.replace(
        anchor, anchor + '        mode: { type: "string", description: "x" },\n'
    )
    assert ts_tool_structure(drifted) != py_tool_structure()


def test_server_info_reports_this_packages_version(tmp_path: Path) -> None:
    """Through a real `initialize`: the SDK used to fill in its own version.

    Needs the `[server]` extra, which CI installs; skips without it, like
    `test_server_builds.py`. The three structure arms above need only this
    package.
    """
    pytest.importorskip("mcp")
    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"},
        },
    }
    env = {**os.environ, "MCP_FS_SANDBOX_ALLOWLIST": str(tmp_path)}
    proc = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import sys; from filesystem_sandbox.server import main; sys.exit(main())",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    # A server that never answers must fail this test, not hang the suite:
    # killing it closes stdout, readline returns b"", and json.loads fails.
    timer = threading.Timer(15, proc.kill)
    timer.start()
    try:
        assert proc.stdin is not None
        assert proc.stdout is not None
        proc.stdin.write((json.dumps(init) + "\n").encode())
        proc.stdin.flush()
        line = proc.stdout.readline()
    finally:
        timer.cancel()
        proc.kill()
        proc.wait(timeout=10)
    reply = json.loads(line)
    assert reply["result"]["serverInfo"] == {
        "name": "filesystem-sandbox-py",
        "version": __version__,
    }
