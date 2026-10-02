"""Atomic byte-write for the filesystem-sandbox MCP tool.

``open(path, "wb")`` is not atomic: the destination is opened with
``O_TRUNC`` (truncates immediately) and the bytes only commit on
completion. If the MCP server is killed mid-write — SIGINT from a
Claude Desktop quit, SIGTERM from an orchestrator restart, OOM,
disk-full — the destination is left zero-length or partial, and on a
*rewrite* the prior content is already gone. Worst shape for an MCP
tool: clients re-read what they wrote, so a half-written file corrupts
the conversational context.

This is the Python parity twin of the TypeScript
``../filesystem-sandbox/src/atomic_write.ts::atomicWriteFile``, and the
bytes variant of the portfolio's text helper
``rag-production-kit/rag_kit/io_utils.py::atomic_write_text`` (#44
there) / ``llm-eval-harness/eval_harness/cli.py::_atomic_write_text``
(#48) / ``llm-cost-optimizer/scripts/_io.py::atomic_write_text`` (#42)
/ ``prompt-regression-suite/prompt_regression/io.py::atomic_write_text``
(#39). Portfolio-wide uniformity is intentional.

Same load-bearing constraint as every sibling: the temp file lives in
the destination's parent directory so the ``os.replace`` is a
same-filesystem rename (atomic on POSIX; a cross-filesystem rename
would degrade to a copy-then-unlink, which is not atomic).
"""

from __future__ import annotations

import contextlib
import os
import secrets
import stat
from pathlib import Path

# Cap the target basename fed into the temp-file name. The temp basename is
# `.{base}.{pid}.{random}.tmp` (the TS twin's shape), so prepending the *full*
# target basename overflows NAME_MAX (255 on macOS/Linux) whenever the target
# basename is itself near NAME_MAX — a name a plain `open(..., "wb")` accepts
# then fails ENAMETOOLONG through this atomic helper. 200 bytes leaves ~55
# bytes of headroom for the dots, the pid, the random token, and the `.tmp`
# suffix. Parity twin of the TS `MAX_TEMP_BASE_BYTES` / `capBaseForTemp`
# (../filesystem-sandbox/src/atomic_write.ts, #96).
MAX_TEMP_BASE_BYTES = 200


def _name_bytes(base: str) -> int:
    """Length of *base* in the bytes the filesystem actually sees.

    ``os.fsencode``, not ``base.encode("utf-8")`` (#160). The budget being
    enforced is NAME_MAX, which limits the bytes handed to the kernel — that is
    ``sys.getfilesystemencoding()`` together with
    ``sys.getfilesystemencodeerrors()``, i.e. ``surrogateescape`` on POSIX. The
    docstring below used to promise "UTF-8 bytes", which is the same number for
    every name that is valid UTF-8 and a different thing entirely for the rest:
    strict ``str.encode("utf-8")`` *raises* on a lone surrogate rather than
    counting it.

    The road in is a lone surrogate through legal JSON. MCP tool arguments
    arrive as JSON, ``"\\udcff"`` is legal escape syntax, and ``json.loads``
    decodes it happily (RFC 8259 section 8.2 names unpaired surrogates as
    non-interoperable; they reach real traffic from broken UTF-16 handling
    upstream). Measured through ``_dispatch_tool("write_file", ...)`` with an
    in-sandbox path, the client got back ``'utf-8' codec can't encode character
    ... surrogates not allowed`` — a bare complaint about this helper's internal
    measurement, naming neither the tool nor the path, on a call whose *content*
    was pure ASCII. The server did not crash (``UnicodeEncodeError`` is a
    ``ValueError``, which is in the dispatch's clean-error tuple), so the only
    symptom was a misleading message.

    The range matters, and it is narrower than "any lone surrogate".
    ``surrogateescape`` only round-trips **U+DC80..U+DCFF** — the codepoints it
    manufactures for the raw bytes 0x80..0xFF — so those are the names the
    kernel can actually hold. Every other surrogate (``U+D800`` and friends) has
    no ``os.fsencode`` representation either, and refusing it is correct both
    before and after this change. A test written against ``U+D800`` would pass
    identically either way; the falsifying input is ``U+DCFF``.

    That also broke the property the TS twin states outright: "the atomic
    helper must accept every name the filesystem does (#96)". ``capBaseForTemp``
    measures with ``Buffer.byteLength(base, "utf8")``, which never throws — it
    counts a lone surrogate as the 3-byte replacement — so the two sides
    disagreed on exactly the input the TS comment says must work.

    ``os.fsencode`` never raises: ``surrogateescape`` on POSIX,
    ``surrogatepass`` on Windows, so every ``str`` a ``Path`` can hold
    round-trips, and the Python side is total over the same domain the TS side
    is. For a name that is valid UTF-8 it returns exactly the old number, so the
    budget is unchanged for every name that worked before.
    """
    return len(os.fsencode(base))


def _cap_base_for_temp(base: str) -> str:
    """Trim ``base`` to at most ``MAX_TEMP_BASE_BYTES`` filesystem bytes.

    "Filesystem bytes", not "UTF-8 bytes": NAME_MAX is a limit on what the
    kernel receives, which is ``os.fsencode`` — see :func:`_name_bytes` for why
    the distinction is load-bearing and not pedantry (#160).

    The temp name only needs to be a recognizable, collision-free sibling;
    the random token plus ``O_EXCL`` guarantees uniqueness, so truncating
    the cosmetic base is safe. Trims by whole characters so no codepoint is
    ever split. Mirrors the TS ``capBaseForTemp``, including its stated
    property that the helper accepts every name the filesystem does.
    """
    if _name_bytes(base) <= MAX_TEMP_BASE_BYTES:
        return base
    out = base
    while out and _name_bytes(out) > MAX_TEMP_BASE_BYTES:
        out = out[:-1]
    return out


# Mode the temp file is created with. 0o666, not 0o600, so the KERNEL applies
# the process umask exactly as the plain `open(path, "wb")` this helper replaced
# did (#200, portfolio-ops#81). `tempfile.NamedTemporaryFile` / `mkstemp` always
# create 0600, and `os.replace` carries that mode onto the target: every file
# `write_file` created was owner-only, and an overwrite demoted 0644 to 0600.
# The umask is never read via an `os.umask(0)` / `os.umask(old)` round-trip —
# that sets a process-global umask of 0 for every other thread in between.
_CREATE_MODE = 0o666


def _existing_mode(target: Path) -> int | None:
    """Permission bits of the file already at *target*, or ``None`` if absent.

    An overwrite keeps the target's mode (#200), which is what the plain
    ``open(path, "wb")`` did: ``O_TRUNC`` reuses the inode, so its mode was
    never touched.

    ``os.stat`` FOLLOWS a symlink, deliberately. Both callers pass the
    sandbox's ``sp.resolved``, which ``Sandbox.resolve`` has already
    realpath'd (and which rejects a dangling or outside-pointing leaf symlink),
    so on every normal path the target is not a symlink at all. If one appears
    in a race, the mode worth copying is the file it points at; a symlink's own
    bits (0o755 on macOS, 0o777 on Linux) would make the result world-writable.
    A dangling link stats as missing and falls back to the umask default.

    Masked to ``0o777``: setuid/setgid/sticky are not carried over. A plain
    write by an unprivileged process makes the kernel drop setuid/setgid, so
    copying them onto new content would be more permissive than the write this
    helper replaced. Parity with the TS twin's ``existingMode``.
    """
    try:
        st = os.stat(target)
    except FileNotFoundError:
        return None
    return stat.S_IMODE(st.st_mode) & 0o777


def atomic_write_bytes(path: str | Path, data: bytes) -> None:
    # Write to a sibling temp file in the destination's parent directory,
    # fsync, then `os.replace` (atomic on POSIX within the same filesystem).
    # Same-directory placement guarantees same filesystem so the rename cannot
    # fall back to a copy. On any exception between the temp write and the
    # rename, the temp is unlinked so a crashed write leaves no debris.
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    name = f".{_cap_base_for_temp(target.name)}.{os.getpid()}.{secrets.token_hex(6)}.tmp"
    candidate = target.parent / name
    tmp_path: Path | None = None
    try:
        # O_EXCL: fail loudly on a name collision rather than clobber a file
        # someone else is writing (parity with the TS twin). Mode 0o666 so the
        # kernel applies the umask (#200, see `_CREATE_MODE`).
        fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, _CREATE_MODE)
        tmp_path = candidate
        with os.fdopen(fd, "wb") as tmp:
            tmp.write(data)
            tmp.flush()
            mode = _existing_mode(target)
            if mode is not None:
                os.chmod(tmp_path, mode)
            os.fsync(tmp.fileno())
        os.replace(tmp_path, target)
        tmp_path = None
    finally:
        if tmp_path is not None:
            with contextlib.suppress(FileNotFoundError):
                tmp_path.unlink()
