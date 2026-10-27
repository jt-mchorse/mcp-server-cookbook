"""Filesystem-sandbox MCP tool implementations.

Each tool routes its ``path`` argument through ``Sandbox.resolve(...)``
before any filesystem syscall. The sandbox layer is what makes the
tools safe; the tools themselves are thin glue.

Mirrors ``../filesystem-sandbox/src/tools.ts`` shape-for-shape:
identical defensive posture, identical error classes, identical
output dicts.
"""

from __future__ import annotations

import contextlib
import errno
import os
import stat
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

from .anchored import AnchorRefused, anchoring_supported, open_anchored_dir
from .atomic_write import atomic_write_bytes
from .sandbox import Sandbox, SandboxedPath, SandboxEscape

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


def _root_dir(sp: SandboxedPath) -> str:
    """The allow-list root ``sp`` belongs to, without its trailing separator."""
    return sp.root[:-1] if len(sp.root) > 1 else sp.root


@contextlib.contextmanager
def _anchor(
    sp: SandboxedPath, dir_path: str, input_value: str, *, readable: bool = False
) -> Iterator[int | None]:
    """Hold ``dir_path`` open beneath ``sp``'s root, refusing a symlink at any
    component (#233). ``resolve`` checked the realpath; this is what makes the
    IO that follows use the directory it checked, not whatever the path names
    by then. ``None`` where the platform has no ``dir_fd`` support.
    """
    if not anchoring_supported():  # pragma: no cover - Windows
        yield None
        return
    try:
        fd = open_anchored_dir(_root_dir(sp), dir_path, readable=readable)
    except AnchorRefused:
        raise SandboxEscape("outside_allowlist", input_value) from None
    try:
        yield fd
    finally:
        os.close(fd)


def list_directory(deps: ToolDeps, dir_path: str) -> list[DirEntry]:
    """Return the directory contents as a sorted-by-name list of entries."""
    sp = deps.sandbox.resolve_dir(dir_path)
    # Through the held directory (#233): `scandir(sp.resolved)` listed whatever
    # a swapped-in symlink pointed at, and the per-entry stat sized its files.
    with _anchor(sp, sp.resolved, dir_path, readable=True) as dfd:
        return _list(sp.resolved if dfd is None else dfd)


def _list(target: str | int) -> list[DirEntry]:
    out: list[DirEntry] = []
    # Kinds from the directory read (`d_type`), as the TS port's `Dirent` does
    # (#285). `os.path.islink`/`isfile`/`isdir` each stat the entry, which needs
    # the directory's search bit: in a readable but unsearchable directory (mode
    # 0644) all three failed and every entry, a subdirectory included, was
    # listed as "other". `DirEntry` answers without a system call; where the
    # filesystem gives no `d_type` it stats, and an `OSError` there is "other".
    with os.scandir(target) as it:
        for e in it:
            size: int | None = None
            try:
                if e.is_symlink():
                    kind: DirEntryKind = "symlink"
                elif e.is_file():
                    kind = "file"
                elif e.is_dir():
                    kind = "directory"
                else:
                    kind = "other"
            except OSError:
                kind = "other"
            # `follow_symlinks=False` (#233): the entry was a file when listed;
            # if it has been swapped for a symlink since, its own size is the
            # honest answer, not the size of whatever it points at.
            if kind == "file":
                try:
                    size = e.stat(follow_symlinks=False).st_size
                except OSError:
                    size = None
            out.append(DirEntry(name=e.name, kind=kind, size=size))
    out.sort(key=lambda e: e.name)
    return out


# Largest single read `read_file` asks for (#279); the TS port's READ_CHUNK_BYTES.
READ_CHUNK_BYTES = 1_048_576


def read_file(deps: ToolDeps, file_path: str) -> str:
    """Read the file as UTF-8 text. Caps at ``max_bytes``.

    Files that aren't valid UTF-8 raise a ``ValueError``; that's the
    same contract the TS server emits.
    """
    sp = deps.sandbox.resolve_file(file_path)
    # One handle for the size check and the read, and the read bounded (#232):
    # `getsize(path)` then `open(path).read()` returned a file that grew in
    # between in full, past the cap. At most `max_bytes + 1` is read here.
    #
    # Opened through the held parent with `O_NOFOLLOW` (#233), so the file is
    # the one `resolve_file` checked even if a component was swapped for a
    # symlink since. `O_NONBLOCK` so a leaf swapped for a FIFO cannot block the
    # open; the type check below then refuses it.
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with _anchor(sp, os.path.dirname(sp.resolved), file_path) as dfd:
        try:
            if dfd is None:  # pragma: no cover - Windows
                fd = os.open(sp.resolved, flags | getattr(os, "O_BINARY", 0))
            else:
                fd = os.open(os.path.basename(sp.resolved), flags, dir_fd=dfd)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise SandboxEscape("outside_allowlist", file_path) from None
            raise
    with open(fd, "rb") as fh:
        st = os.fstat(fh.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise SandboxEscape("not_a_file", file_path)
        size = st.st_size
        if size > deps.max_bytes:
            raise FileTooLargeError(size, deps.max_bytes)
        # Up to `max_bytes + 1`, in chunks (#279): `fh.read(max_bytes + 1)`
        # sizes its buffer by the cap, so the top of the accepted range
        # (MAX_SAFE_INTEGER, the #137 parity contract) raised MemoryError on a
        # 5-byte file. The TS port reads the same way.
        limit = deps.max_bytes + 1
        parts: list[bytes] = []
        total = 0
        while total < limit:
            part = fh.read(min(READ_CHUNK_BYTES, limit - total))
            if not part:
                break
            parts.append(part)
            total += len(part)
        raw = b"".join(parts)
    if len(raw) > deps.max_bytes:
        raise FileTooLargeError(len(raw), deps.max_bytes)
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
    # Type-guard ``content`` before encoding. The server casts
    # ``arguments["content"]`` with no runtime validation and the SDK doesn't
    # enforce inputSchema types, so a present-but-non-string reaches here.
    # Without this, ``(123).encode(...)`` raises a raw ``AttributeError`` that
    # the dispatch's clean-error tuple doesn't catch (surfaces as
    # ``unexpected error: ...``). ``ValueError`` IS in that tuple, so it renders
    # cleanly. Mirrors the ``path`` isinstance contract (``_validate_input``) and
    # the TS twin's guard (#119, sibling of #117).
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    data = content.encode("utf-8")
    if len(data) > deps.max_bytes:
        raise FileTooLargeError(len(data), deps.max_bytes)
    sp = deps.sandbox.resolve(file_path, must_exist=False)
    # A directory is not a writable file, and the allow-list root is one (#238).
    # ``resolve`` accepts the root itself, and ``atomic_write_bytes`` stages its
    # temp file in the target's PARENT -- for the root, outside the sandbox --
    # so the caller's bytes were written there before ``os.replace`` failed.
    # Refused before any write, with the reason the read path uses; parity with
    # the TS twin.
    if sp.resolved == _root_dir(sp):
        raise SandboxEscape("not_a_file", file_path)
    # Everything below goes through the held parent (#233): the directory
    # check, the temp file, the mode copy and the rename. By path, a parent
    # swapped for a symlink after `resolve` put the bytes outside the root.
    base = os.path.basename(sp.resolved)
    with _anchor(sp, os.path.dirname(sp.resolved), file_path) as dfd:
        try:
            st = os.stat(
                base if dfd is not None else sp.resolved, dir_fd=dfd, follow_symlinks=False
            )
            is_dir = stat.S_ISDIR(st.st_mode)
        except OSError:
            is_dir = False
        if is_dir:
            raise SandboxEscape("not_a_file", file_path)
        # Atomic write (temp + fsync + os.replace) so a mid-write crash can't
        # leave a partial/truncated file — parity with the TS twin's
        # `atomicWriteFile`.
        atomic_write_bytes(sp.resolved, data, dir_fd=dfd)
    return {"bytes_written": len(data)}
