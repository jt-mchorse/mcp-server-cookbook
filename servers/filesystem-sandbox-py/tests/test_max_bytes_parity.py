"""``MCP_FS_SANDBOX_MAX_BYTES`` value-domain parity with the TS port (#137).

#98 made the two ports agree on the *grammar* — which literal forms parse. It
did not make them agree on the *value domain*, and that is where an
arbitrary-precision language and a float-backed one diverge:

- ``int("9007199254740993")`` is exact here, while ``Number(...)`` in the TS
  port produced ``9007199254740992`` with ``Number.isInteger`` and
  ``Number.isFinite`` both true — so the same config gave the two servers
  different caps, with no diagnostic on either side.
- A 310-digit value was accepted here as an effectively unbounded cap, while
  the TS port overflowed to ``Infinity`` and refused to start. That is verbatim
  the "starts one port, hard-fails the other" harm #98 set out to fix.

The table lives in ``test-fixtures/max_bytes_parity.json`` and is read by
*both* suites, so the ports are exercised against literally the same inputs
rather than two hand-maintained copies that can drift apart the way the
implementations did.

Every accepting row asserts the resulting ``max_bytes``, not just
accept/reject. That is the point: the rounding rows pass an
accept/reject-only check on the broken tree, because both ports *accepted* —
they just produced different numbers.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from filesystem_sandbox.config import (
    MAX_SAFE_INTEGER,
    read_sandbox_config_from_env,
)

_TABLE_PATH = Path(__file__).resolve().parents[3] / "test-fixtures" / "max_bytes_parity.json"


def _load_table() -> dict:
    assert _TABLE_PATH.is_file(), (
        f"shared parity table missing at {_TABLE_PATH}; it is read by both the "
        "TS and Python suites and must not be moved without updating both"
    )
    return json.loads(_TABLE_PATH.read_text(encoding="utf-8"))


_TABLE = _load_table()
_CASES = _TABLE["cases"]


def _raw_for(case: dict) -> str | None:
    """`{"digits": N}` expands to '1' followed by N-1 zeros."""
    if "digits" in case:
        return "1" + "0" * (case["digits"] - 1)
    return case.get("raw")


def _env_for(case: dict) -> dict[str, str]:
    env = {"MCP_FS_SANDBOX_ALLOWLIST": "/tmp/a"}
    raw = _raw_for(case)
    if raw is not None:
        env["MCP_FS_SANDBOX_MAX_BYTES"] = raw
    return env


def test_shared_table_is_present_and_non_trivial() -> None:
    """A silently empty parity suite is worse than none — fail loudly if the
    fixture is gone or gutted."""
    assert len(_CASES) > 20
    assert _TABLE["max_safe_integer"] == MAX_SAFE_INTEGER
    assert _TABLE["default_max_bytes"] == 1_000_000


@pytest.mark.parametrize("case", _CASES, ids=[c["label"] for c in _CASES])
def test_port_matches_the_shared_parity_table(case: dict) -> None:
    if not case["accept"]:
        with pytest.raises(ValueError, match="MCP_FS_SANDBOX_MAX_BYTES"):
            read_sandbox_config_from_env(_env_for(case))
        return
    cfg = read_sandbox_config_from_env(_env_for(case))
    assert cfg.max_bytes == case["max_bytes"]


def test_max_safe_integer_is_the_boundary() -> None:
    cfg = read_sandbox_config_from_env(
        {"MCP_FS_SANDBOX_ALLOWLIST": "/tmp/a", "MCP_FS_SANDBOX_MAX_BYTES": str(MAX_SAFE_INTEGER)}
    )
    assert cfg.max_bytes == MAX_SAFE_INTEGER

    with pytest.raises(ValueError, match="MCP_FS_SANDBOX_MAX_BYTES"):
        read_sandbox_config_from_env(
            {
                "MCP_FS_SANDBOX_ALLOWLIST": "/tmp/a",
                "MCP_FS_SANDBOX_MAX_BYTES": str(MAX_SAFE_INTEGER + 1),
            }
        )


def test_no_accepted_value_is_silently_altered() -> None:
    """For every accepted input, the enforced cap must equal the digits the
    operator wrote. This is the TS port's rounding defect stated as a property,
    asserted on this side too so the invariant is symmetric."""
    for case in _CASES:
        if not case["accept"]:
            continue
        raw = _raw_for(case)
        if raw is None or not raw.strip():
            continue
        cfg = read_sandbox_config_from_env(_env_for(case))
        assert cfg.max_bytes == int(raw.strip()), case["label"]


def test_overlong_digit_string_never_reaches_int() -> None:
    """CPython 3.11+ raises ``ValueError: Exceeds the limit (4300 digits) for
    integer string conversion; use sys.set_int_max_str_digits()...`` — an
    interpreter-implementation message that names neither this variable nor
    anything an operator can act on. The length check must fire first so the
    documented message is what they see.
    """
    with pytest.raises(ValueError, match="MCP_FS_SANDBOX_MAX_BYTES") as exc:
        read_sandbox_config_from_env(
            {"MCP_FS_SANDBOX_ALLOWLIST": "/tmp/a", "MCP_FS_SANDBOX_MAX_BYTES": "1" + "0" * 4999}
        )

    msg = str(exc.value)
    assert "MCP_FS_SANDBOX_MAX_BYTES" in msg, msg
    assert "set_int_max_str_digits" not in msg, (
        f"CPython's internal digit-limit message leaked to the operator: {msg}"
    )
