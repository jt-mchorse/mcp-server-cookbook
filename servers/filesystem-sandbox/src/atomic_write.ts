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

// Cap the target basename's contribution to the temp filename. The temp name
// is `.<base>.<pid>.<12-hex>.tmp`; the affixes add ~25 bytes, so prepending a
// full basename that is itself near NAME_MAX (255 on ext4/APFS) overflows the
// limit and the write fails with ENAMETOOLONG — even though a plain
// `fs.writeFile` of that same target succeeds. Since `write_file` takes a
// client-supplied path, that spurious failure is reachable; the atomic helper
// must accept every name the filesystem does (#96). The base in the temp name
// is cosmetic (`ls`-ability) — uniqueness is guaranteed by the random token +
// pid + O_EXCL — so truncating it is safe. Budget is in BYTES (NAME_MAX is a
// byte limit) and we trim on a char boundary.
const MAX_TEMP_BASE_BYTES = 200;

function capBaseForTemp(base: string): string {
  if (Buffer.byteLength(base, "utf8") <= MAX_TEMP_BASE_BYTES) return base;
  let out = base;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > MAX_TEMP_BASE_BYTES) {
    out = out.slice(0, -1);
  }
  return out;
}

// Mode the temp file is created with. 0o666, not 0o600, so the KERNEL applies
// the process umask exactly as the plain `fs.writeFile` this helper replaced
// did (#200, portfolio-ops#81). With 0o600 the rename carried owner-only onto
// the target: every file `write_file` created was 0600 under umask 022, and an
// overwrite demoted 0644 to 0600. The umask is never read via
// `process.umask()` — never mutate (or depend on) the process-global umask.
const CREATE_MODE = 0o666;

/**
 * Permission bits of the file already at `target`, or `null` if absent.
 *
 * An overwrite keeps the target's mode (#200), which is what the plain
 * `fs.writeFile` did: `O_TRUNC` reuses the inode, so its mode was never
 * touched.
 *
 * `fs.stat` FOLLOWS a symlink, deliberately. The caller passes the sandbox's
 * `sp.resolved`, which `Sandbox.resolve` has already realpath'd (and which
 * rejects a dangling or outside-pointing leaf symlink), so on every normal
 * path the target is not a symlink at all. If one appears in a race, the mode
 * worth copying is the file it points at; a symlink's own bits (0o755 on
 * macOS, 0o777 on Linux) would make the result world-writable. A dangling link
 * stats as ENOENT and falls back to the umask default.
 *
 * Masked to `0o777`: setuid/setgid/sticky are not carried over. A plain write
 * by an unprivileged process makes the kernel drop setuid/setgid, so copying
 * them onto new content would be more permissive than the write this helper
 * replaced. Parity with the Python twin's `_existing_mode`.
 */
async function existingMode(target: string): Promise<number | null> {
  try {
    return (await fs.stat(target)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function atomicWriteFile(target: string, data: Buffer): Promise<void> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  await fs.mkdir(dir, { recursive: true });

  const token = randomBytes(6).toString("hex");
  const tmp = path.join(dir, `.${capBaseForTemp(base)}.${process.pid}.${token}.tmp`);

  // O_WRONLY | O_CREAT | O_EXCL — fail loudly if the temp name
  // already exists (collision with a concurrent attempt by another
  // process); never silently clobber. Mode 0o666 so the kernel applies the
  // umask (#200, see `CREATE_MODE`).
  const handle = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, CREATE_MODE);
  let renamed = false;
  try {
    await handle.writeFile(data);
    const mode = await existingMode(target);
    if (mode !== null) await handle.chmod(mode);
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
