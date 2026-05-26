/**
 * Atomic file write for the filesystem-sandbox MCP tool.
 *
 * `fs.promises.writeFile` is not atomic: the destination is opened
 * with `O_WRONLY | O_CREAT | O_TRUNC` (truncates immediately) and
 * the bytes only commit on completion. If the MCP server is killed
 * mid-write — SIGINT from a Claude Desktop quit, SIGTERM from an
 * orchestrator restart, OOM, disk-full — the destination is left
 * zero-length or partial. Worst shape for an MCP tool: clients
 * re-read what they wrote, so a half-written file corrupts the
 * conversational context.
 *
 * Pattern is the TypeScript cross-language sibling of the Python
 * helpers landed earlier this session:
 * `llm-eval-harness/eval_harness/cli.py::_atomic_write_text` (#48),
 * `llm-cost-optimizer/scripts/_io.py::atomic_write_text` (#42),
 * `prompt-regression-suite/prompt_regression/io.py::atomic_write_text` (#39),
 * `rag-production-kit/rag_kit/io_utils.py::atomic_write_text` (#44).
 *
 * Same load-bearing constraint: the temp file lives in the
 * destination's parent directory so the rename is same-filesystem
 * (`fs.rename` is atomic on POSIX within the same filesystem; cross-
 * filesystem renames degrade to a copy-then-unlink, which is not atomic).
 */

import { randomBytes } from "node:crypto";
import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";

export async function atomicWriteFile(target: string, data: Buffer): Promise<void> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  await fs.mkdir(dir, { recursive: true });

  const token = randomBytes(6).toString("hex");
  const tmp = path.join(dir, `.${base}.${process.pid}.${token}.tmp`);

  // O_WRONLY | O_CREAT | O_EXCL — fail loudly if the temp name
  // already exists (collision with a concurrent attempt by another
  // process); never silently clobber.
  const handle = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  let renamed = false;
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      // `handle.close()` is idempotent on a closed handle (Node throws
      // ERR_INVALID_STATE; swallow). If we never reached the close
      // line because writeFile/sync threw, close here.
      try {
        await handle.close();
      } catch {
        // Already closed or failed-to-open; either way no further cleanup possible on the handle.
      }
      try {
        await fs.unlink(tmp);
      } catch {
        // Temp may already be gone (rename succeeded but we never set
        // renamed=true due to an error after, or unlink loses a race
        // with another cleanup). Either way nothing to do.
      }
    }
  }
}
