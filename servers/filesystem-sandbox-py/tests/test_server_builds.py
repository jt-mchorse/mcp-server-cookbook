"""The server `main` runs can actually be built (#176, D-013).

`pip install -e '.[server]'` resolved mcp 2.2.0 under the unbounded
`mcp>=1.27`, and the documented `mcp-filesystem-sandbox-py` then crashed on
startup: `'Server' object has no attribute 'list_tools'`. All 250 tests stayed
green, because the server was built and run in one function behind stdio and
nothing constructed it. These arms build it exactly as `main` does and call
its registered handlers through the SDK's own request table, so an SDK that
cannot host this server fails here rather than in an operator's terminal.

Needs the `[server]` extra, which CI installs; skips cleanly without it, like
`test_server_iserror.py`.
"""

from __future__ import annotations

import asyncio
import re
import tomllib
from pathlib import Path

import pytest

mcp_types = pytest.importorskip("mcp.types")

from filesystem_sandbox.sandbox import Sandbox  # noqa: E402
from filesystem_sandbox.server import _build_server  # noqa: E402
from filesystem_sandbox.tools import ToolDeps  # noqa: E402

_PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _server(root: Path):
    deps = ToolDeps(sandbox=Sandbox.create([str(root)]), read_only=False, max_bytes=1024)
    return _build_server(deps)


def _dump(result: object) -> dict:
    return result.model_dump(by_alias=True)  # type: ignore[attr-defined]


def test_the_server_builds_and_lists_its_three_tools(tmp_path: Path) -> None:
    server = _server(tmp_path)
    handler = server.request_handlers[mcp_types.ListToolsRequest]
    result = asyncio.run(handler(mcp_types.ListToolsRequest(method="tools/list")))
    names = sorted(t["name"] for t in _dump(result)["tools"])
    assert names == ["list_directory", "read_file", "write_file"]


def _call(server, name: str, arguments: dict) -> dict:
    handler = server.request_handlers[mcp_types.CallToolRequest]
    request = mcp_types.CallToolRequest(
        method="tools/call",
        params=mcp_types.CallToolRequestParams(name=name, arguments=arguments),
    )
    return _dump(asyncio.run(handler(request)))


def test_a_refusal_through_the_built_server_sets_is_error(tmp_path: Path) -> None:
    payload = _call(_server(tmp_path), "read_file", {"path": "/etc/passwd"})
    assert payload["isError"] is True


def test_an_allowed_read_through_the_built_server_does_not(tmp_path: Path) -> None:
    (tmp_path / "hello.txt").write_text("hi", encoding="utf-8")
    payload = _call(_server(tmp_path), "read_file", {"path": str(tmp_path / "hello.txt")})
    assert payload["isError"] is False
    assert "hi" in payload["content"][0]["text"]


def test_every_runtime_sdk_requirement_has_an_upper_major_bound() -> None:
    """An unbounded SDK range is how a fresh install got a major the code had
    never run on. Dev tooling is out of scope here (portfolio-ops#62)."""
    extras = tomllib.loads(_PYPROJECT.read_text(encoding="utf-8"))["project"][
        "optional-dependencies"
    ]
    runtime = [r for name, reqs in extras.items() if name != "dev" for r in reqs]
    assert runtime, "no runtime extras found; the walk is looking at the wrong table"
    unbounded = [r for r in runtime if not re.search(r"<\s*\d", r)]
    assert not unbounded, f"runtime requirements without an upper bound: {unbounded}"
