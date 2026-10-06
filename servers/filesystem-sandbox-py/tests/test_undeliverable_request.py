r"""A request the SDK transport drops is answered, not left hanging (#210, D-015).

The pinned SDK (mcp 1.x) validates every stdio line with pydantic's JSON
parser, which refuses a lone surrogate escape (``"\ud800"``) that ``json.loads``
accepts. Such a line was turned into a logged "Internal Server Error" and its
request id was never answered. Measured on main in a real stdio session::

    -> {"jsonrpc":"2.0","id":4,"method":"tools/call",...{"path":"/etc/\ud800x"}}
    <- {"method":"notifications/message",...,"data":"Internal Server Error"}
       (no response for id 4)

The TS port answers the same request. These tests drive the real console
entry point over stdio, as a client does.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from filesystem_sandbox.server import _answer_undeliverable, _undeliverable_request

_INIT = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "t", "version": "0"},
    },
}
_INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}
# Written by hand: `json.dumps` would escape the backslash, and this must be
# the six-character escape a client sends, not a literal backslash.
_LONE_SURROGATE_READ = (
    '{"jsonrpc":"2.0","id":4,"method":"tools/call",'
    '"params":{"name":"read_file","arguments":{"path":"/etc/\\ud800x"}}}'
)


def _read(request_id: int, path: str) -> str:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": "read_file", "arguments": {"path": path}},
        }
    )


def _session(tmp_path: Path, *lines: str) -> dict[object, dict]:
    """Send `lines` over a real stdio session, close stdin, return replies by id.

    `communicate` closes stdin after writing, so the server sees end of input
    and must exit by itself: a request left unanswered shows up as a missing
    id, and a server that hangs at shutdown fails the timeout.
    """
    pytest.importorskip("mcp")
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
    try:
        out, _ = proc.communicate(("\n".join(lines) + "\n").encode(), timeout=30)
    finally:
        proc.kill()
        proc.wait(timeout=10)
    replies = [json.loads(line) for line in out.decode().splitlines() if line.strip()]
    return {r["id"]: r for r in replies if "id" in r}


def test_a_lone_surrogate_request_is_answered_and_the_session_continues(tmp_path: Path) -> None:
    replies = _session(
        tmp_path,
        json.dumps(_INIT),
        json.dumps(_INITIALIZED),
        _LONE_SURROGATE_READ,
        _read(5, "/etc/passwd"),
    )
    assert replies[4]["error"]["code"] == -32602
    assert "lone surrogate" in replies[4]["error"]["message"]
    assert "result" not in replies[4]
    # The next request on the same session is still served normally.
    assert replies[5]["result"]["isError"] is True
    assert replies[5]["result"]["content"][0]["text"].startswith(
        "sandbox_escape (outside_allowlist)"
    )


def test_an_undeliverable_request_on_the_last_line_is_still_answered(tmp_path: Path) -> None:
    # End of input follows immediately: the answer must be written before the
    # server shuts down, not dropped with the rest of the task group.
    replies = _session(tmp_path, json.dumps(_INIT), json.dumps(_INITIALIZED), _LONE_SURROGATE_READ)
    assert replies[4]["error"]["code"] == -32602


def test_a_request_the_sdk_rejects_for_another_reason_is_answered_too(tmp_path: Path) -> None:
    # No "jsonrpc" member: pydantic refuses it and the SDK dropped it the same
    # way. JSON-RPC's own code for that is Invalid Request.
    missing_version = json.dumps({"id": 7, "method": "tools/list"})
    replies = _session(tmp_path, json.dumps(_INIT), json.dumps(_INITIALIZED), missing_version)
    assert replies[7]["error"]["code"] == -32600


@pytest.mark.parametrize(
    "line",
    [
        pytest.param(_read(5, "/etc/passwd"), id="valid-request"),
        pytest.param(json.dumps(_INITIALIZED), id="valid-notification"),
        # Notifications have no id to answer; the SDK still sees them.
        pytest.param(
            '{"jsonrpc":"2.0","method":"notifications/x","params":{"p":"\\ud800"}}',
            id="lone-surrogate-notification",
        ),
        pytest.param("not json at all", id="unparseable"),
        # An id that is itself a lone surrogate cannot be echoed back.
        pytest.param(
            '{"jsonrpc":"2.0","id":"\\ud800","method":"tools/list"}', id="lone-surrogate-id"
        ),
        pytest.param(
            '{"jsonrpc":"2.0","id":true,"method":"tools/list","params":{"p":"\\ud800"}}',
            id="boolean-id",
        ),
    ],
)
def test_everything_else_reaches_the_sdk_unchanged(line: str) -> None:
    pytest.importorskip("mcp")
    assert _undeliverable_request(line) is None

    async def run() -> tuple[list[str], list[object]]:
        import anyio

        send, recv = anyio.create_memory_object_stream(10)

        async def lines():
            yield line

        passed = [x async for x in _answer_undeliverable(lines(), send)]
        answers = [x async for x in recv]
        return passed, answers

    passed, answers = asyncio.run(run())
    assert passed == [line]  # byte-identical
    assert answers == []
