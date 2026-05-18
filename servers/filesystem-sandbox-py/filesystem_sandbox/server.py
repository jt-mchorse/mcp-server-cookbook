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

    Identical shape to the TypeScript implementation under
    ``../filesystem-sandbox/src/server.ts``; if the schemas drift,
    the cookbook's spec-version check will catch it before merge.
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


def _error_message(err: BaseException) -> str:
    """Stringify a tool error for the MCP response.

    The typed sandbox / tool errors carry messages that are already
    safe to show — they never echo allow-list contents or absolute
    paths beyond what the caller already supplied.
    """
    if isinstance(err, SandboxEscape):
        return f"sandbox_escape ({err.reason}): {err}"
    if isinstance(err, WriteForbiddenError):
        return str(err)
    if isinstance(err, FileTooLargeError):
        return str(err)
    if isinstance(err, ValueError):
        return f"value_error: {err}"
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


async def _serve(deps: ToolDeps) -> None:
    """Wire the tool dispatcher into the official Python MCP SDK.

    Imports the SDK lazily so the security primitive's tests don't
    need it installed.
    """
    # Local import keeps the module's top-level import-cost zero for
    # tests that don't run the server.
    from mcp import types
    from mcp.server import Server
    from mcp.server.stdio import stdio_server

    server = Server("filesystem-sandbox-py")

    @server.list_tools()
    async def _list_tools() -> list[types.Tool]:
        return [types.Tool(**t) for t in _build_tool_specs()]

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
        text, is_error = _dispatch_tool(name, arguments or {}, deps)
        # The SDK's CallToolResult is shaped via the return type;
        # `is_error=True` propagates by raising or by adding to the
        # response. Returning text content with the typed error
        # message gives the caller the same surface as the TS server.
        return [types.TextContent(type="text", text=text)]

    async with stdio_server() as (read, write):
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
