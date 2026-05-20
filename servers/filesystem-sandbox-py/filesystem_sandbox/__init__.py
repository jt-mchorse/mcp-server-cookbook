"""Filesystem-sandbox MCP server (Python parity port).

Mirrors the TypeScript implementation under
``../filesystem-sandbox/`` line-for-line where idiomatic; deviates only
where the Python idiom differs (e.g., ``os.path.realpath`` is sync, so
the API doesn't need the ``async`` annotations).

Public surface:

    from filesystem_sandbox import Sandbox, SandboxEscape

The MCP server boilerplate lives in ``filesystem_sandbox.server`` and
is imported lazily so the security primitive's tests run without the
``mcp`` Python SDK installed.
"""

__version__ = "0.1.0"  # mirror of pyproject.toml [project] version

from .sandbox import Sandbox, SandboxedPath, SandboxEscape, SandboxEscapeReason

__all__ = ["Sandbox", "SandboxedPath", "SandboxEscape", "SandboxEscapeReason"]
