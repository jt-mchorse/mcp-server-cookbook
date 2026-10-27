"""Directory descriptors opened beneath an allow-list root without following
any symlink (#233).

``Sandbox.resolve`` proves a path is inside the allow-list by realpath'ing it.
That proof is about the tree at the moment of the check. The tools used to then
open ``sp.resolved`` BY PATH, and the kernel walked every component a second
time: a directory swapped for a symlink in between (a writer inside the root
can do that, the threat the D-006 symlink rule defends against) was followed,
and reads, listings and writes all landed outside the root.

Here the realpath'd directory is walked once, one component at a time, each
opened relative to the previous descriptor with ``O_DIRECTORY | O_NOFOLLOW``,
so a symlinked component fails instead of being followed. Callers then name
every file relative to the result with ``dir_fd=``, so a later swap of a parent
changes nothing: the descriptor still refers to the directory that was checked.

The walk opens with ``O_PATH`` on Linux and ``O_SEARCH`` on macOS, which need
only search permission -- what a path lookup needed before -- and falls back to
``O_RDONLY`` where a directory is readable but not searchable (#285).

The realpath'd path never contains a symlink, so refusing one here never
refuses a request the check accepted unless the tree changed mid-call. The TS
port does the same through ``/proc/self/fd`` and ``/.vol`` (``anchored.ts``),
because Node has no ``openat``.
"""

from __future__ import annotations

import contextlib
import errno
import os

# ``O_PATH`` (Linux) and ``O_SEARCH`` (macOS) are absent elsewhere; ``O_RDONLY``
# is the portable fallback.
_DIR_FLAGS = getattr(os, "O_PATH", 0) or getattr(os, "O_SEARCH", 0) or os.O_RDONLY
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)


class AnchorRefused(Exception):
    """A component of the walk is (now) a symlink, or no longer a directory."""


def anchoring_supported() -> bool:
    """Whether this platform's ``os`` takes ``dir_fd`` for every call made."""
    return {
        os.open,
        os.stat,
        os.rename,
        os.unlink,
    } <= os.supports_dir_fd and os.scandir in os.supports_fd


def _open_dir(name: str, dir_fd: int | None, *, follow: bool, readable: bool) -> int:
    nofollow = 0 if follow else os.O_NOFOLLOW
    kinds = [os.O_RDONLY] if readable else [_DIR_FLAGS, os.O_RDONLY]
    for i, kind in enumerate(kinds):
        try:
            return os.open(name, kind | os.O_DIRECTORY | nofollow | _CLOEXEC, dir_fd=dir_fd)
        except PermissionError:
            if i == len(kinds) - 1:
                raise
    raise AssertionError("unreachable")  # pragma: no cover


def open_anchored_dir(root: str, dir_path: str, *, readable: bool = False) -> int:
    """Open ``dir_path`` (realpath'd, equal to or under ``root``) refusing a
    symlink at every component below ``root``. Returns a descriptor the caller
    closes. ``readable`` asks for one ``os.scandir`` can read.

    Raises ``AnchorRefused`` when a component is a symlink or not a directory.
    """
    rel = os.path.relpath(dir_path, root)
    if rel == os.pardir or rel.startswith(os.pardir + os.sep) or os.path.isabs(rel):
        raise AnchorRefused(dir_path)
    names = [] if rel == os.curdir else rel.split(os.sep)
    # The root itself by path: it was realpath'd at boot and only the operator
    # controls the directories above it (D-005).
    fd = _open_dir(root, None, follow=True, readable=readable and not names)
    try:
        for i, name in enumerate(names):
            last = i == len(names) - 1
            try:
                nxt = _open_dir(name, fd, follow=False, readable=readable and last)
            except OSError as exc:
                # ELOOP from O_NOFOLLOW on a symlink; ENOTDIR from O_DIRECTORY
                # on a symlink opened O_PATH (Linux) or on a non-directory.
                if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise AnchorRefused(dir_path) from exc
                raise
            os.close(fd)
            fd = nxt
    except BaseException:
        with contextlib.suppress(OSError):
            os.close(fd)
        raise
    return fd
