"""Filesystem-sandbox MCP tool implementations.

Each tool routes its ``path`` argument through ``Sandbox.resolve(...)``
before any filesystem syscall. The sandbox layer is what makes the
tools safe; the tools themselves are thin glue.

Mirrors ``../filesystem-sandbox/src/tools.ts`` shape-for-shape:
identical defensive posture, identical error classes, identical
output dicts.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from .sandbox import Sandbox

DirEntryKind = Literal["file", "directory", "symlink", "other"]


@dataclass
class ToolDeps:
    """Injected configuration the tool handlers need.

    Built once at server start; not mutated per call.
    """

    sandbox: Sandbox
    read_only: bool = False
    max_bytes: int = 1_048_576  # 1 MiB default; matches the TS server


class WriteForbiddenError(Exception):
    """Raised when ``write_file`` is called while ``read_only`` is True."""

    def __init__(self) -> None:
        super().__init__("write_file is disabled (MCP_FS_SANDBOX_READ_ONLY=1)")


class FileTooLargeError(Exception):
    """Raised when a file would exceed the configured byte cap."""

    def __init__(self, size: int, limit: int) -> None:
        super().__init__(f"file size {size} > limit {limit} bytes")
        self.size = size
        self.limit = limit


@dataclass(frozen=True)
class DirEntry:
    name: str
    kind: DirEntryKind
    size: int | None = None


def list_directory(deps: ToolDeps, dir_path: str) -> list[DirEntry]:
    """Return the directory contents as a sorted-by-name list of entries."""
    sp = deps.sandbox.resolve_dir(dir_path)
    out: list[DirEntry] = []
    for name in os.listdir(sp.resolved):
        full = os.path.join(sp.resolved, name)
        if os.path.islink(full):
            kind: DirEntryKind = "symlink"
            size: int | None = None
        elif os.path.isfile(full):
            kind = "file"
            try:
                size = os.path.getsize(full)
            except OSError:
                size = None
        elif os.path.isdir(full):
            kind = "directory"
            size = None
        else:
            kind = "other"
            size = None
        out.append(DirEntry(name=name, kind=kind, size=size))
    out.sort(key=lambda e: e.name)
    return out


def read_file(deps: ToolDeps, file_path: str) -> str:
    """Read the file as UTF-8 text. Caps at ``max_bytes``.

    Files that aren't valid UTF-8 raise a ``ValueError``; that's the
    same contract the TS server emits.
    """
    sp = deps.sandbox.resolve_file(file_path)
    size = os.path.getsize(sp.resolved)
    if size > deps.max_bytes:
        raise FileTooLargeError(size, deps.max_bytes)
    with open(sp.resolved, "rb") as fh:
        raw = fh.read()
    try:
        return raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValueError(f"file is not valid UTF-8 text: {file_path}") from exc


def write_file(deps: ToolDeps, file_path: str, content: str) -> dict[str, int]:
    """Write ``content`` to ``file_path`` as UTF-8.

    Raises ``WriteForbiddenError`` when the server is read-only,
    ``FileTooLargeError`` when the content exceeds the cap, and any
    ``SandboxEscape`` from the sandbox layer.
    """
    if deps.read_only:
        raise WriteForbiddenError()
    data = content.encode("utf-8")
    if len(data) > deps.max_bytes:
        raise FileTooLargeError(len(data), deps.max_bytes)
    sp = deps.sandbox.resolve(file_path, must_exist=False)
    with open(sp.resolved, "wb") as fh:
        fh.write(data)
    return {"bytes_written": len(data)}
