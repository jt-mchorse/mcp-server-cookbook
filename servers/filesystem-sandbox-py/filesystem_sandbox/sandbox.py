"""Filesystem sandbox: every input path is resolved against an
allow-list of canonical roots before any file syscall touches it.

Threat model (mirrored in this server's README):

- **Protects against.** A misbehaving (or attacker-controlled) MCP
  client asking the server to read or write outside the allow-list.
  Path-traversal (``../../../etc/passwd``), absolute paths outside
  roots, symlinks pointing outside, null-byte injection, and
  carriage-return / control-character smuggling all surface as
  ``SandboxEscape`` errors *before* any IO.
- **Does not protect against.** Resource exhaustion (giant reads,
  write storms), denial-of-service, or the client *legitimately*
  reading files inside the allow-list it shouldn't. Out-of-scope
  here; downstream layers handle quota/rate-limit/audit.

Implementation notes:

1. Roots are resolved to their canonical (symlink-followed) real path
   once, at construction. A symlinked allow-list root is fine; the
   *resolved* target is what's checked.
2. Per-call resolution uses ``os.path.realpath`` (follows symlinks)
   so a symlink under the allow-list pointing outside *must not*
   succeed (D-006 in the cookbook's MEMORY).
3. Containment check is a ``<root>/`` prefix match on the resolved
   path. The trailing separator matters: ``/tmp/foo`` must not match
   ``/tmp/foobar`` as a substring; ``/tmp/foo/`` does.

The TypeScript implementation under ``../filesystem-sandbox/src/``
uses an async-by-default API because Node's ``fs.realpath`` is async.
Python's ``os.path.realpath`` is sync, so this port exposes a sync
API — same posture, idiomatic-language. The MCP server handlers
adapt either shape to the SDK's async dispatcher.
"""

from __future__ import annotations

import os
import os.path
from dataclasses import dataclass
from typing import Literal

SandboxEscapeReason = Literal[
    "input_empty",
    "input_null_byte",
    "input_control_char",
    "input_relative_disallowed",
    "outside_allowlist",
    "symlink_outside_allowlist",
    "root_does_not_exist",
    "not_a_file",
    "not_a_directory",
]


class SandboxEscape(Exception):
    """Raised when a path input would escape the allow-list.

    Carries the (un-PII-fied) input plus a typed ``reason`` so the MCP
    server's catch boundary can serialize a descriptive error without
    leaking the operator's allow-list contents.
    """

    def __init__(
        self,
        reason: SandboxEscapeReason,
        input_value: str,
        message: str | None = None,
    ) -> None:
        super().__init__(message or f"{reason}: {input_value!r}")
        self.reason: SandboxEscapeReason = reason
        self.input: str = input_value


@dataclass(frozen=True)
class SandboxedPath:
    """The canonical, symlink-resolved absolute path plus its owning root."""

    resolved: str
    root: str


class Sandbox:
    """Allow-list resolver for filesystem paths.

    Construction validates the allow-list and resolves each root to
    its canonical form. The instance is immutable after that —
    rebuild a new ``Sandbox`` to change the allow-list, rather than
    mutating an existing one.
    """

    def __init__(self, resolved_roots: list[str]) -> None:
        # Private constructor — callers go through ``Sandbox.create``.
        self._roots: tuple[str, ...] = tuple(resolved_roots)

    @classmethod
    def create(cls, roots: list[str]) -> "Sandbox":
        """Build a sandbox over ``roots``. Each root must exist and
        be a directory; symlinks are followed once at construction."""
        if not roots:
            raise ValueError(
                "Sandbox requires at least one allow-list root. "
                "Empty allow-list would mean every path is rejected — "
                "that's a config bug, not a useful sandbox state."
            )
        resolved: list[str] = []
        for r in roots:
            real = _realpath_or_throw(r)
            with_sep = real if real.endswith(os.sep) else real + os.sep
            resolved.append(with_sep)
        return cls(resolved)

    @property
    def allowed_roots(self) -> tuple[str, ...]:
        """Read-only view of the resolved allow-list roots."""
        return self._roots

    def resolve(self, input_value: str, *, must_exist: bool = True) -> SandboxedPath:
        """Resolve ``input_value`` against the allow-list.

        Raises ``SandboxEscape`` on any rejection. Returns the
        ``SandboxedPath`` otherwise.

        ``must_exist=False`` lets writes target a path that doesn't
        exist yet (the parent directory must exist + be in the
        allow-list).
        """
        _validate_input(input_value)
        if not os.path.isabs(input_value):
            raise SandboxEscape(
                "input_relative_disallowed",
                input_value,
                "input path must be absolute; relative paths are rejected "
                "to avoid CWD-dependent surprises",
            )

        if must_exist:
            if not os.path.lexists(input_value):
                raise SandboxEscape("outside_allowlist", input_value)
            real = os.path.realpath(input_value)
        else:
            parent = os.path.dirname(input_value)
            if not os.path.isdir(parent):
                raise SandboxEscape("outside_allowlist", input_value)
            parent_real = os.path.realpath(parent)
            real = os.path.join(parent_real, os.path.basename(input_value))

        for root in self._roots:
            if _under_root(real, root):
                return SandboxedPath(resolved=real, root=root)
        raise SandboxEscape("outside_allowlist", input_value)

    def resolve_dir(self, input_value: str) -> SandboxedPath:
        """Resolve and assert the path is a directory."""
        sp = self.resolve(input_value)
        if not os.path.isdir(sp.resolved):
            raise SandboxEscape("not_a_directory", input_value)
        return sp

    def resolve_file(self, input_value: str) -> SandboxedPath:
        """Resolve and assert the path is a regular file."""
        sp = self.resolve(input_value)
        if not os.path.isfile(sp.resolved):
            raise SandboxEscape("not_a_file", input_value)
        return sp


def _validate_input(input_value: str) -> None:
    if not isinstance(input_value, str) or len(input_value) == 0:
        raise SandboxEscape("input_empty", input_value if isinstance(input_value, str) else "")
    if "\0" in input_value:
        raise SandboxEscape("input_null_byte", input_value)
    # Reject other ASCII control characters (0x01-0x1f, 0x7f). They
    # have no place in a filesystem path; rejecting them prevents
    # log-injection / terminal-escape shenanigans downstream.
    for ch in input_value:
        code = ord(ch)
        if code == 0:
            continue  # already caught above
        if code < 0x20 or code == 0x7F:
            raise SandboxEscape("input_control_char", input_value)


def _under_root(resolved: str, root_with_sep: str) -> bool:
    """Check that ``resolved`` is inside ``root_with_sep``.

    The root already has a trailing separator; the resolved path's
    exact equality to root-minus-trailing-sep is also valid.
    """
    root_no_sep = root_with_sep[:-1]
    return resolved == root_no_sep or resolved.startswith(root_with_sep)


def _realpath_or_throw(p: str) -> str:
    try:
        if not os.path.lexists(p):
            raise FileNotFoundError(p)
        return os.path.realpath(p)
    except OSError as exc:
        raise SandboxEscape(
            "root_does_not_exist",
            p,
            f"allow-list root does not exist: {p} ({exc})",
        ) from exc
