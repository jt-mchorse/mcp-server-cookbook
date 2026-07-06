"""isError propagation for the MCP adapter (#88).

`_call_tool` previously returned a bare `[TextContent(...)]` list and
discarded the `is_error` half of `_dispatch_tool`'s result, so the SDK
reported `isError: false` for *every* outcome — including sandbox escapes,
read-only write refusals, oversize/binary reads, and unknown tools. That
contradicts the parity claim in the module + README (the TS sibling returns
`isError: true` on every refusal, and MCP clients key off that flag).

`_wrap_dispatch_result` now carries the `(text, is_error)` decision into the
SDK's `CallToolResult`, which the low-level server returns verbatim.

The `_dispatch_tool` decision test is dependency-free. The wrapper tests
need the `[server]` extra (`mcp`) and skip cleanly when it isn't installed,
so the security primitive's dep-free tests still run.
"""

import pytest

from filesystem_sandbox.server import _dispatch_tool, _wrap_dispatch_result


def test_dispatch_unknown_tool_flags_error() -> None:
    # The unknown-tool branch returns before touching deps, so None is fine.
    text, is_error = _dispatch_tool("does_not_exist", {}, None)  # type: ignore[arg-type]
    assert is_error is True
    assert "unknown tool" in text


def test_wrap_error_result_sets_iserror_true() -> None:
    pytest.importorskip("mcp")
    result = _wrap_dispatch_result("sandbox_escape (outside_allowlist): /etc/hosts", True)
    assert result.isError is True
    assert result.content[0].text == "sandbox_escape (outside_allowlist): /etc/hosts"


def test_wrap_success_result_sets_iserror_false() -> None:
    pytest.importorskip("mcp")
    result = _wrap_dispatch_result("hello", False)
    assert result.isError is False
    assert result.content[0].text == "hello"
