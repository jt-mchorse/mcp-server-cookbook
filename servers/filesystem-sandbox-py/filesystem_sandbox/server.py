"""MCP server boilerplate for the filesystem-sandbox Python port.

The interesting code lives in ``filesystem_sandbox.sandbox`` and
``filesystem_sandbox.tools``; this file is the SDK adapter that wires
the three tools (``list_directory``, ``read_file``, ``write_file``) to
the official Python MCP server's request handlers.

The ``mcp`` package is imported here, not at the package level, so the
security primitive's tests run with zero runtime deps. Operators who
want to *run* the server install the ``[server]`` extra.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from dataclasses import asdict
from typing import Any

from .config import read_sandbox_config_from_env
from .sandbox import Sandbox, SandboxEscape
from .tools import (
    FileTooLargeError,
    ToolDeps,
    WriteForbiddenError,
    list_directory,
    read_file,
    write_file,
)


def _build_tool_specs() -> list[dict[str, Any]]:
    """Tool schemas exposed by the server.

    The same STRUCTURE as the TypeScript port's ``TOOLS`` in
    ``../filesystem-sandbox/src/server.ts``: tool names, property names and
    types, ``required`` and ``additionalProperties``. The descriptions are
    worded independently and differ. ``tests/test_tool_surface_parity.py``
    checks the structure; nothing else did, whatever this docstring used to
    say about the spec-version check, which compares SDK pins only (#189).
    """
    return [
        {
            "name": "list_directory",
            "description": (
                "List entries under an allow-listed directory. Returns "
                "name + kind (file/directory/symlink/other) for each "
                "entry; files also carry size in bytes. Sorted by name."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path inside one of the allow-list roots.",
                    }
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
        {
            "name": "read_file",
            "description": (
                "Read an allow-listed file as UTF-8 text. Refuses binary "
                "files and files over the configured byte cap "
                "(MCP_FS_SANDBOX_MAX_BYTES, default 1 MB)."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path inside one of the allow-list roots.",
                    }
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
        {
            "name": "write_file",
            "description": (
                "Write UTF-8 content to an allow-listed file path. "
                "Refused when MCP_FS_SANDBOX_READ_ONLY=1. Caps at "
                "MCP_FS_SANDBOX_MAX_BYTES."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path inside one of the allow-list roots.",
                    },
                    "content": {
                        "type": "string",
                        "description": "UTF-8 content to write.",
                    },
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
        },
    ]


_LONE_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")


def _json_wellformed(value: str) -> str:
    r"""``json.dumps`` with JavaScript's ES2019 *well-formed* semantics.

    `JSON.stringify` escapes a lone surrogate rather than emitting it (the
    "well-formed JSON.stringify" proposal, ES2019). Python's `json.dumps` has
    no equivalent mode: `ensure_ascii=False` writes the raw codepoint, which
    has no UTF-8 encoding, so the refusal message this builds cannot be written
    to the stdio transport at all (#163)::

        JSON.stringify("\uD800bad.txt")                 -> '"\ud800bad.txt"'  (survives)
        json.dumps("\ud800bad.txt", ensure_ascii=False)  -> raw U+D800         (UnicodeEncodeError)

    And it arrives by an ordinary road, not an exotic one: a lone surrogate is
    legal **JSON escape syntax**, so `json.loads('"\ud800bad.txt"')` on an
    incoming JSON-RPC argument produces one with no filesystem or `argv`
    involved. The docstring below used to say it "cannot reach this port at
    all"; it reaches ``_dispatch_tool`` in one hop. Over stdio it does not get
    that far: the SDK transport's pydantic parser rejects the escape first, so
    `_serve` answers that request with a JSON-RPC error instead (#210, D-015).
    This escaping covers every other road -- a direct `_dispatch_tool` call, or
    an SDK that accepts the escape.

    `ensure_ascii=True` is not the fix. It matches JS on this codepoint and
    diverges on every other non-ASCII one -- `café.txt` would become
    `"caf\u00e9.txt"` while the TS port still emits `"café.txt"`, trading one
    diverging codepoint for all of them. Escaping *only* surrogates is exactly
    what ES2019 specified, and it leaves the eight-of-nine agreement intact.

    A valid surrogate **pair** is not a lone surrogate: it is a single astral
    codepoint by then, so the regex cannot see it and JS does not escape it
    either. `test-fixtures/error_message_parity.json` carries that control.
    """
    dumped = json.dumps(value, ensure_ascii=False)
    return _LONE_SURROGATE_RE.sub(lambda m: f"\\u{ord(m.group()):04x}", dumped)


def _error_message(err: BaseException) -> str:
    """Stringify a tool error for the MCP response.

    Byte-identical to the TypeScript port's ``errorMessage``, pinned by the
    shared table in ``test-fixtures/error_message_parity.json`` (#148, D-010).
    This is the only parity surface a client actually reads; the other four
    shared tables cover internals. Before #148 all four arms diverged:

        arm                TypeScript                     Python
        SandboxEscape      sandbox refusal (r): <raw>     sandbox_escape (r): r: '<repr>'
        generic error      <message>                      value_error: <message>

    Two of those were defects on their own terms rather than parity
    preferences. ``SandboxEscape.__init__`` already puts ``f"{reason}:
    {input!r}"`` into the message, so formatting ``{err}`` after ``({err.reason})``
    made the reason appear **twice**; format ``err.input`` instead. And the
    ``value_error:`` prefix had no counterpart at all in the other port, whose
    equivalent sites raise a plain ``Error`` with the *same message text* --
    dropping the prefix makes the two identical rather than inventing a label
    for the TypeScript side.

    The input is JSON-quoted rather than interpolated raw. An unquoted path
    carrying a space, a trailing separator, or a NUL is ambiguous in a refusal
    message, and ambiguity is exactly what a sandbox refusal must not have.
    ``json.dumps(..., ensure_ascii=False)`` and JavaScript's ``JSON.stringify``
    agree on eight of nine awkward codepoints. The ninth is a lone surrogate,
    and this docstring used to say it "cannot reach this port at all". It is
    legal JSON escape syntax, so ``json.loads`` produces one (#163), and
    ``_json_wellformed`` above escapes it the way ES2019's well-formed
    ``JSON.stringify`` does, so all nine agree here. Over stdio under mcp 1.x
    the SDK's parser refuses the line before this function runs, and `_serve`
    answers it with a JSON-RPC error (#210, D-015).

    The typed sandbox / tool errors carry messages that are already safe to
    show — they never echo allow-list contents or absolute paths beyond what
    the caller already supplied.
    """
    if isinstance(err, SandboxEscape):
        return f"sandbox_escape ({err.reason}): {_json_wellformed(err.input)}"
    if isinstance(err, WriteForbiddenError):
        return str(err)
    if isinstance(err, FileTooLargeError):
        return str(err)
    return str(err)


def _dispatch_tool(name: str, arguments: dict[str, Any], deps: ToolDeps) -> tuple[str, bool]:
    """Call the matching tool handler and JSON-serialize the result.

    Returns ``(text, is_error)`` so the MCP layer can wrap the result
    in the SDK's ``CallToolResult`` shape without re-deriving the
    error decision.
    """
    try:
        if name == "list_directory":
            out = list_directory(deps, arguments["path"])
            payload = [asdict(e) for e in out]
            return json.dumps(payload, indent=2), False
        if name == "read_file":
            text = read_file(deps, arguments["path"])
            return text, False
        if name == "write_file":
            result = write_file(deps, arguments["path"], arguments["content"])
            return json.dumps(result, indent=2), False
        return f"unknown tool: {name}", True
    except (SandboxEscape, WriteForbiddenError, FileTooLargeError, ValueError) as err:
        return _error_message(err), True
    except Exception as err:  # noqa: BLE001 — boundary catch
        return f"unexpected error: {err}", True


def _wrap_dispatch_result(text: str, is_error: bool) -> Any:
    """Wrap a ``(text, is_error)`` dispatch result in the SDK's
    ``CallToolResult`` so the MCP ``isError`` flag actually reflects tool
    failures.

    This is the parity guarantee the module docstring and README claim: the
    TS sibling returns ``isError: true`` on every refusal (sandbox escape,
    read-only write, oversize/binary read, unknown tool), and an MCP client
    keys off that flag. Returning a bare content list — as this adapter did
    before — always reported ``isError: false``, so a client saw *success*
    for denied/failed operations. The low-level SDK returns a
    ``CallToolResult`` verbatim when the handler produces one, so this is how
    the flag propagates.

    Imported lazily to keep the security primitive's tests dependency-free.
    """
    from mcp import types

    return types.CallToolResult(
        content=[types.TextContent(type="text", text=text)],
        isError=is_error,
    )


def _build_server(deps: ToolDeps) -> Any:
    """The MCP server with both handlers registered, exactly as `main` runs it.

    Split out of `_serve` (#176) so a test can build it without stdio. It used
    to be built and run in one function, which is how mcp 2.2.0 -- which the
    unbounded `mcp>=1.27` resolved on a fresh install -- crashed this server on
    startup (`'Server' object has no attribute 'list_tools'`) while all 250
    tests stayed green: none of them constructed it.

    Imports the SDK lazily so the security primitive's tests don't need it.
    """
    from mcp import types
    from mcp.server import Server

    from . import __version__

    # Without `version=`, the SDK advertises its OWN package version in
    # `serverInfo` (it said 1.28.1 while this package is 0.1.0) (#189).
    server = Server("filesystem-sandbox-py", version=__version__)

    @server.list_tools()
    async def _list_tools() -> list[types.Tool]:
        return [types.Tool(**t) for t in _build_tool_specs()]

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        text, is_error = _dispatch_tool(name, arguments or {}, deps)
        # Return a CallToolResult so `is_error` reaches the client's MCP
        # `isError` flag — matching the TS server (which flags every
        # refusal). A bare content list always reported isError:false.
        return _wrap_dispatch_result(text, is_error)

    return server


# JSON-RPC 2.0 error codes for a request the SDK transport cannot deliver.
_INVALID_REQUEST = -32600
_INVALID_PARAMS = -32602


def _undeliverable_request(line: str) -> tuple[str | int, int, str] | None:
    """``(id, code, message)`` for a request the SDK transport would drop, else None.

    The pinned SDK (mcp 1.x) validates every stdio line with pydantic's JSON
    parser. A line that parser rejects is turned into an exception the server
    logs as a ``notifications/message`` "Internal Server Error" -- and its
    request id is **never answered**, so the client hangs (#210). The common
    case is a lone surrogate escape (``"path": "/etc/\\ud800x"``): legal JSON
    escape syntax that ``json.loads`` accepts, and that pydantic refuses before
    any tool runs. A hang is what #163 said a sandbox refusal must never be.

    A line is answered here only when it is a request this port could reply to:
    the SDK rejects it, ``json.loads`` reads an object with a ``method`` and a
    string or integer ``id``. A notification has no id to answer; a line
    neither parser can read has no id either. Both still reach the SDK
    unchanged, as does every line the SDK accepts. The message never echoes
    the offending value: a lone surrogate has no UTF-8 encoding, so it cannot
    be written back to the transport.
    """
    from mcp import types

    try:
        types.JSONRPCMessage.model_validate_json(line)
        return None
    except ValueError:
        pass
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("method"), str):
        return None
    request_id = obj.get("id")
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        return None
    if isinstance(request_id, str) and _LONE_SURROGATE_RE.search(request_id):
        return None
    if _LONE_SURROGATE_RE.search(json.dumps(obj, ensure_ascii=False)):
        return (
            request_id,
            _INVALID_PARAMS,
            "Invalid params: the request contains a lone surrogate escape (U+D800-U+DFFF), "
            "which the MCP Python SDK's transport cannot accept; no tool was called",
        )
    return (
        request_id,
        _INVALID_REQUEST,
        "Invalid Request: the MCP Python SDK's transport rejected this message",
    )


async def _answer_undeliverable(lines: Any, answers: Any) -> Any:
    """Yield `lines` to the SDK, diverting each undeliverable request to `answers`.

    `answers` is the send side of a stream that `_serve` forwards into the SDK's
    own write stream, so an answer reaches stdout through the same writer as
    every other response and can never interleave with one mid-line.
    """
    from mcp import types
    from mcp.shared.message import SessionMessage

    async with answers:
        async for line in lines:
            undeliverable = _undeliverable_request(line)
            if undeliverable is None:
                yield line
                continue
            request_id, code, message = undeliverable
            error = types.JSONRPCError(
                jsonrpc="2.0", id=request_id, error=types.ErrorData(code=code, message=message)
            )
            await answers.send(SessionMessage(types.JSONRPCMessage(error)))


async def _serve(deps: ToolDeps) -> None:
    """Run `_build_server(deps)` over stdio, answering what the SDK would drop (#210)."""
    import math
    from io import TextIOWrapper

    import anyio
    from mcp.server.stdio import stdio_server

    server = _build_server(deps)
    # The SDK's own default stdin, wrapped so an undeliverable request gets an
    # answer instead of a hang.
    stdin = anyio.wrap_file(TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace"))
    answers_send, answers_recv = anyio.create_memory_object_stream(math.inf)

    async def forward_answers(write: Any) -> None:
        async with answers_recv:
            async for answer in answers_recv:
                await write.send(answer)

    filtered = _answer_undeliverable(stdin, answers_send)
    async with stdio_server(stdin=filtered) as (read, write), anyio.create_task_group() as tg:
        # Ends when the filter closes `answers_send` at end of input, so an
        # answer to the very last line is still written before shutdown.
        tg.start_soon(forward_answers, write)
        await server.run(read, write, server.create_initialization_options())


def main() -> int:
    """Entry point for the ``mcp-filesystem-sandbox-py`` console script."""
    try:
        cfg = read_sandbox_config_from_env()
    except ValueError as exc:
        print(f"filesystem-sandbox-py: config error: {exc}", file=sys.stderr)
        return 2

    try:
        sandbox = Sandbox.create(list(cfg.allowed_roots))
    except (SandboxEscape, ValueError) as exc:
        print(f"filesystem-sandbox-py: failed to build sandbox: {exc}", file=sys.stderr)
        return 2

    deps = ToolDeps(sandbox=sandbox, read_only=cfg.read_only, max_bytes=cfg.max_bytes)

    print(
        f"filesystem-sandbox-py starting; allowed_roots={sandbox.allowed_roots} "
        f"read_only={cfg.read_only} max_bytes={cfg.max_bytes}",
        file=sys.stderr,
    )

    asyncio.run(_serve(deps))
    return 0


if __name__ == "__main__":
    sys.exit(main())
