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
            prefix=f".{target.name}.",
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
