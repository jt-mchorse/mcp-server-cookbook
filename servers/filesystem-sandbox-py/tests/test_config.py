"""Tests for the Python parity port's env-config parser.

Mirrors ``../filesystem-sandbox/test/config.test.ts``.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from filesystem_sandbox.config import (  # noqa: E402
    DEFAULT_MAX_BYTES,
    read_sandbox_config_from_env,
)


def test_requires_allowlist_env():
    with pytest.raises(ValueError, match="MCP_FS_SANDBOX_ALLOWLIST is required"):
        read_sandbox_config_from_env({})


def test_rejects_empty_allowlist():
    with pytest.raises(ValueError, match="required"):
        read_sandbox_config_from_env({"MCP_FS_SANDBOX_ALLOWLIST": "   :  "})


def test_parses_colon_separated_paths():
    cfg = read_sandbox_config_from_env({"MCP_FS_SANDBOX_ALLOWLIST": "/tmp/a:/tmp/b: /tmp/c "})
    assert cfg.allowed_roots == ("/tmp/a", "/tmp/b", "/tmp/c")


def test_defaults_read_only_false_and_default_max_bytes():
    cfg = read_sandbox_config_from_env({"MCP_FS_SANDBOX_ALLOWLIST": "/tmp"})
    assert cfg.read_only is False
    assert cfg.max_bytes == DEFAULT_MAX_BYTES


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "Yes", "YES"])
def test_read_only_truthy_values(value: str):
    cfg = read_sandbox_config_from_env(
        {"MCP_FS_SANDBOX_ALLOWLIST": "/tmp", "MCP_FS_SANDBOX_READ_ONLY": value}
    )
    assert cfg.read_only is True


@pytest.mark.parametrize("value", ["0", "false", "no", "", "off"])
def test_read_only_falsy_values(value: str):
    cfg = read_sandbox_config_from_env(
        {"MCP_FS_SANDBOX_ALLOWLIST": "/tmp", "MCP_FS_SANDBOX_READ_ONLY": value}
    )
    assert cfg.read_only is False


def test_max_bytes_override():
    cfg = read_sandbox_config_from_env(
        {"MCP_FS_SANDBOX_ALLOWLIST": "/tmp", "MCP_FS_SANDBOX_MAX_BYTES": "4096"}
    )
    assert cfg.max_bytes == 4096


@pytest.mark.parametrize("value", ["0", "-1", "abc", "1.5"])
def test_max_bytes_rejects_invalid_values(value: str):
    with pytest.raises(ValueError, match="positive integer"):
        read_sandbox_config_from_env(
            {"MCP_FS_SANDBOX_ALLOWLIST": "/tmp", "MCP_FS_SANDBOX_MAX_BYTES": value}
        )
