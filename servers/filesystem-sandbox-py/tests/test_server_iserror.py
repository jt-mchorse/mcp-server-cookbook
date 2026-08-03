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

Assert on the **serialized** payload, not on a Python attribute name (#134).
These tests originally read `result.isError`, which is an implementation
detail of the SDK's pydantic model rather than the contract above — and mcp
2.0.0 renamed that attribute to `is_error` while keeping `isError` as the
wire alias. The parity guarantee held perfectly; only the tests broke, on a
rename that never reached a client. Swapping to `result.is_error` would just
move the brittleness, since mcp 1.x is still inside the declared
`mcp>=1.27` range. `model_dump(by_alias=True)["isError"]` is stable across
both majors (verified against 1.29.0 and 2.0.0) and is literally what an MCP
client receives, so it tests the claim instead of the spelling.
"""

import pytest

from filesystem_sandbox.server import _dispatch_tool, _wrap_dispatch_result


def _wire(result: object) -> dict:
    """The payload an MCP client actually receives.

    ``by_alias=True`` emits the protocol field names (``isError``) rather
    than whatever the SDK currently calls them in Python.
    """
    return result.model_dump(by_alias=True)  # type: ignore[attr-defined]


def test_dispatch_unknown_tool_flags_error() -> None:
    # The unknown-tool branch returns before touching deps, so None is fine.
    text, is_error = _dispatch_tool("does_not_exist", {}, None)  # type: ignore[arg-type]
    assert is_error is True
    assert "unknown tool" in text


def test_wrap_error_result_sets_iserror_true() -> None:
    pytest.importorskip("mcp")
    result = _wrap_dispatch_result("sandbox_escape (outside_allowlist): /etc/hosts", True)
    wire = _wire(result)
    assert wire["isError"] is True
    assert wire["content"][0]["text"] == "sandbox_escape (outside_allowlist): /etc/hosts"


def test_wrap_success_result_sets_iserror_false() -> None:
    pytest.importorskip("mcp")
    result = _wrap_dispatch_result("hello", False)
    wire = _wire(result)
    assert wire["isError"] is False
    assert wire["content"][0]["text"] == "hello"


def test_wrapper_uses_the_constructor_keyword_that_works_on_both_sdk_majors() -> None:
    """`_wrap_dispatch_result` passes ``isError=`` to ``CallToolResult``.

    That is the compatibility hinge, and it is deliberately the *alias*
    rather than the field name: mcp 1.x names the field ``isError``, and
    mcp 2.x renamed it to ``is_error`` but sets ``populate_by_name`` so the
    alias still populates. Passing ``is_error=`` would therefore work on 2.x
    and break on 1.x, which is still inside the declared ``mcp>=1.27``
    range. If a future SDK drops alias population this fails loudly here,
    next to the explanation, rather than silently shipping ``isError:
    false`` on every refusal — the exact regression #88 fixed.
    """
    pytest.importorskip("mcp")
    for flag in (True, False):
        assert _wire(_wrap_dispatch_result("x", flag))["isError"] is flag
