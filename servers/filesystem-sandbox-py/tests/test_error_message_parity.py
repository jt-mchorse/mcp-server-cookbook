"""Error-message parity with the TypeScript port (#148, D-010).

Four shared tables preceded this one -- MAX_BYTES grammar (#98), max-bytes
value domain (#137), config trim charset (#139), and ``resolve()`` (#141) --
and every one covers an **internal**: how a config value is trimmed, how a
path resolves, what byte budget is accepted. The string a client reads when a
call is refused had never been compared, and all four arms diverged::

    arm             TypeScript                                Python
    SandboxEscape   sandbox refusal (outside_allowlist): /etc/passwd
                                                              sandbox_escape (outside_allowlist): outside_allowlist: '/etc/passwd'
    generic error   content must be a string                  value_error: content must be a string

Two of those were defects on this port's own terms, not parity preferences.
``SandboxEscape.__init__`` already puts ``f"{reason}: {input!r}"`` into the
message, so ``_error_message`` prepending ``({err.reason})`` made the reason
appear **twice**. And the ``value_error:`` prefix had no counterpart in the
other port at all, though both raise the *same message text* at the
corresponding sites.

This README opens with "A line-for-line port ... same threat model, same
tools". This is the table that makes that true of the one surface a caller
actually sees.

The table lives in ``test-fixtures/error_message_parity.json`` and is read by
BOTH suites, so the ports are exercised against literally the same
expectations rather than two hand-maintained copies that can drift apart the
way the implementations did.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from filesystem_sandbox.sandbox import SandboxEscape
from filesystem_sandbox.server import _error_message
from filesystem_sandbox.tools import FileTooLargeError, WriteForbiddenError

REPO_ROOT = Path(__file__).resolve().parents[3]
TABLE = REPO_ROOT / "test-fixtures" / "error_message_parity.json"


def _load_table() -> dict[str, Any]:
    return json.loads(TABLE.read_text(encoding="utf-8"))


_TABLE = _load_table()
_CASES: list[dict[str, Any]] = _TABLE["cases"]


def _build_error(case: dict[str, Any]) -> BaseException:
    kind = case["kind"]
    if kind == "sandbox_escape":
        return SandboxEscape(case["reason"], case["input"])
    if kind == "write_forbidden":
        return WriteForbiddenError()
    if kind == "file_too_large":
        return FileTooLargeError(case["size"], case["limit"])
    if kind == "generic":
        # This port raised `ValueError` at both corresponding sites; the other
        # raises a plain `Error` with the same text. The arm under test is the
        # fallthrough, so the concrete type must not change the output.
        return ValueError(case["message"])
    raise AssertionError(f"unknown kind {kind!r}")


def test_shared_table_is_present_and_non_trivial() -> None:
    """Same anti-vacuous guard the other four parity suites carry: a table that
    failed to load, or shrank to the happy path, must fail loudly rather than
    silently asserting nothing."""
    assert TABLE.is_file(), f"shared parity table missing at {TABLE}"
    assert len(_CASES) >= 10
    assert {c["kind"] for c in _CASES} == {
        "sandbox_escape",
        "write_forbidden",
        "file_too_large",
        "generic",
    }


def test_every_arm_of_error_message_is_represented() -> None:
    """The four `isinstance` branches. A fifth arm added later without a row
    here would be an unpinned client-visible string."""
    assert len([c for c in _CASES if c["kind"] == "sandbox_escape"]) >= 6
    for kind in ("write_forbidden", "file_too_large", "generic"):
        assert any(c["kind"] == kind for c in _CASES), kind


def test_table_covers_the_inputs_that_make_quoting_load_bearing() -> None:
    """A space, a NUL, a trailing separator, an empty string, and a quote --
    the shapes an unquoted interpolation renders ambiguously. Without these the
    quoting half of D-010 would be untested."""
    inputs = [c["input"] for c in _CASES if c["kind"] == "sandbox_escape"]
    assert "" in inputs
    assert any(" " in i for i in inputs)
    assert any(chr(0) in i for i in inputs)
    assert any(i.endswith("/") for i in inputs)
    assert any('"' in i for i in inputs)


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_port_matches_the_shared_parity_table(case: dict[str, Any]) -> None:
    assert _error_message(_build_error(case)) == case["expected"]


def test_the_reason_appears_exactly_once() -> None:
    """The defect this port had independent of parity.

    `SandboxEscape.__init__` puts the reason in the message, so formatting the
    *exception* after `({err.reason})` printed it twice:

        sandbox_escape (outside_allowlist): outside_allowlist: '/etc/passwd'

    Asserted as a count rather than by comparing to the fixed string, so it
    keeps holding if the surrounding format ever changes.
    """
    msg = _error_message(SandboxEscape("outside_allowlist", "/etc/passwd"))
    assert msg.count("outside_allowlist") == 1, msg


def test_a_generic_error_carries_no_type_label() -> None:
    """The `value_error:` prefix is gone. The other port's fallthrough is
    `err.message` with no label, and both ports raise the same text at the two
    corresponding sites, so a label here is a pure divergence."""
    assert _error_message(ValueError("content must be a string")) == "content must be a string"
    assert _error_message(RuntimeError("boom")) == "boom"


# --- #163: the property the transport actually needs -------------------------


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_every_message_can_be_written_to_the_stdio_transport(case: dict[str, Any]) -> None:
    """A refusal that cannot be encoded is a refusal the client never sees.

    No test stated this before #163, and it is what the defect actually was:
    `_error_message` built a correct message containing a raw lone surrogate,
    and the response then failed at serialization instead of reaching the
    caller. Comparing the message to an `expected` string cannot catch that --
    both sides held the same unencodable text and compared equal.
    """
    message = _error_message(_build_error(case))
    message.encode("utf-8")


def test_the_table_contains_an_unencodable_input() -> None:
    """Anti-vacuous arm for the test above.

    Every row was UTF-8-safe before the surrogate rows were added, so the
    property held vacuously over the whole table. Assert the population
    actually contains the hazard it exists to check.
    """
    hazardous = [
        c
        for c in _CASES
        if isinstance(c.get("input"), str) and any(0xD800 <= ord(ch) <= 0xDFFF for ch in c["input"])
    ]
    assert len(hazardous) >= 3, (
        "the parity table carries no lone-surrogate input, so "
        "test_every_message_can_be_written_to_the_stdio_transport proves nothing"
    )
    for case in hazardous:
        with pytest.raises(UnicodeEncodeError):
            case["input"].encode("utf-8")


def test_the_controls_are_non_ascii_but_encodable() -> None:
    """The rows that kill the `ensure_ascii=True` neighbour.

    That flag fixes the surrogate rows and escapes every other non-ASCII
    codepoint, so the ports would diverge on `café.txt` instead. These rows
    must be non-ASCII *and* encodable, or they cannot separate the two fixes.
    """
    controls = [c for c in _CASES if "CONTROL" in c["name"]]
    assert len(controls) >= 2, [c["name"] for c in _CASES]
    for case in controls:
        text = case["input"]
        assert not text.isascii(), case["name"]
        text.encode("utf-8")
        # And the expected message must carry the character raw, not escaped.
        assert text in case["expected"], case["name"]
