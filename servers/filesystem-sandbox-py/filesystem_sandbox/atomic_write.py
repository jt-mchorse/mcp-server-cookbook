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
import tempfile
from pathlib import Path

# Cap the target basename fed into the temp-file prefix. `NamedTemporaryFile`
# builds the temp basename as `.{base}.{random}{suffix}`, so prepending the
# *full* target basename overflows NAME_MAX (255 on macOS/Linux) whenever the
# target basename is itself near NAME_MAX — a name a plain `open(..., "wb")`
# accepts then fails ENAMETOOLONG through this atomic helper. 200 bytes leaves
# ~55 bytes of headroom for the leading dot, the random token, and the `.tmp`
# suffix. Parity twin of the TS `MAX_TEMP_BASE_BYTES` / `capBaseForTemp`
# (../filesystem-sandbox/src/atomic_write.ts, #96).
MAX_TEMP_BASE_BYTES = 200


def _cap_base_for_temp(base: str) -> str:
    """Trim ``base`` to at most ``MAX_TEMP_BASE_BYTES`` UTF-8 bytes.

    The temp name only needs to be a recognizable, collision-free sibling;
    ``NamedTemporaryFile``'s random token guarantees uniqueness, so truncating
    the cosmetic base is safe. Trims by whole characters so the result stays
    valid UTF-8 (a byte-slice could split a multi-byte codepoint). Mirrors the
    TS ``capBaseForTemp``.
    """
    if len(base.encode("utf-8")) <= MAX_TEMP_BASE_BYTES:
        return base
    out = base
    while out and len(out.encode("utf-8")) > MAX_TEMP_BASE_BYTES:
        out = out[:-1]
    return out


def atomic_write_bytes(path: str | Path, data: bytes) -> None:
    # Write to a sibling temp file in the destination's parent directory,
    # fsync, then `os.replace` (atomic on POSIX within the same filesystem).
    # Same-directory placement guarantees same filesystem so the rename cannot
    # fall back to a copy. On any exception between the temp write and the
    # rename, the temp is unlinked so a crashed write leaves no debris.
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=target.parent,
            prefix=f".{_cap_base_for_temp(target.name)}.",
            suffix=".tmp",
            delete=False,
        ) as tmp:
            tmp_path = Path(tmp.name)
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, target)
        tmp_path = None
    finally:
        if tmp_path is not None:
            with contextlib.suppress(FileNotFoundError):
                tmp_path.unlink()
