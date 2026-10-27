/**
 * Directory handles opened beneath an allow-list root WITHOUT following any
 * symlink, and child paths that resolve through the handle rather than
 * through the path again (#233).
 *
 * `Sandbox.resolve` proves a path is inside the allow-list by realpath'ing it.
 * That proof is about the tree at the moment of the check. The tools used to
 * then open `sp.resolved` BY PATH, and the kernel walked every component a
 * second time: a directory swapped for a symlink in between (a writer inside
 * the root can do that, the same threat the D-006 symlink rule defends
 * against) was followed, and reads, listings and writes all landed outside.
 *
 * The fix is to walk the realpath'd directory once, refusing a symlink at
 * every component, and keep the result as a handle. Everything after that is
 * named relative to the handle, so a later swap of a parent changes nothing:
 * the handle still refers to the directory that was checked. Node has no
 * `openat`, so a child of a handle is spelled as a path the kernel resolves
 * through the handle itself:
 *
 * - Linux: `/proc/self/fd/<fd>/<name>`. The magic link jumps to the open
 *   directory; it is not re-resolved from a string. The walk opens each
 *   component with `O_PATH | O_DIRECTORY | O_NOFOLLOW` through the previous
 *   one, so a symlinked component fails ENOTDIR. `O_PATH` needs only search
 *   permission, which is what a path lookup needed before.
 * - macOS: one `open` of the realpath'd directory with `O_NOFOLLOW_ANY`, which
 *   refuses a symlink at ANY component, then `/.vol/<dev>/<ino>/<name>`:
 *   volfs looks the child up in the directory with that inode, which the open
 *   handle pins. `O_SEARCH` likewise needs only search permission.
 * - Anywhere else (Windows): `null`, and callers keep the path-based
 *   behaviour. There is no `/proc` or `/.vol` to anchor through.
 *
 * The realpath'd path never contains a symlink, so refusing one here never
 * refuses a request the check accepted unless the tree changed mid-call.
 */

import { promises as fs, constants as fsc } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

// Not in `fs.constants`, so spelled out. libuv passes `open` flags through
// unchanged, so these reach the kernel as written.
/** Linux `O_PATH` (x86-64, arm64, riscv). */
const LINUX_O_PATH = 0o10000000;
/** darwin `O_NOFOLLOW_ANY` (macOS 11+): no symlink at any component. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
/** darwin `O_SEARCH` (`O_EXEC | O_DIRECTORY`): a directory, search permission only. */
const DARWIN_O_SEARCH = 0x40100000;

/** A directory held open beneath an allow-list root. */
export interface AnchoredDir {
  /** A path naming the held directory itself, resolved through the handle. */
  readonly self: string;
  /** A path naming `name` inside the held directory, resolved through the handle. */
  child(name: string): string;
  close(): Promise<void>;
}

/** Thrown when a component of the walk is (now) a symlink, or no longer a directory. */
export class AnchorRefused extends Error {
  constructor(readonly dir: string) {
    super(`a path component of ${JSON.stringify(dir)} is a symlink or not a directory`);
    this.name = "AnchorRefused";
  }
}

function refusal(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "ENOTDIR";
}

/**
 * Open `dir` (a realpath'd directory equal to or under `root`) without
 * following a symlink anywhere at or below `root`. `null` on a platform with
 * no way to anchor.
 */
export async function openAnchoredDir(root: string, dir: string): Promise<AnchoredDir | null> {
  if (process.platform === "linux") return openLinux(root, dir);
  if (process.platform === "darwin") return openDarwin(dir);
  return null;
}

async function openLinux(root: string, dir: string): Promise<AnchoredDir> {
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new AnchorRefused(dir);
  // The root itself by path: it was realpath'd at boot and only the operator
  // controls the directories above it (D-005).
  let fh: FileHandle = await fs.open(root, LINUX_O_PATH | fsc.O_DIRECTORY);
  try {
    for (const name of rel === "" ? [] : rel.split(path.sep)) {
      const next = await fs.open(
        `/proc/self/fd/${fh.fd}/${name}`,
        LINUX_O_PATH | fsc.O_DIRECTORY | fsc.O_NOFOLLOW,
      );
      await fh.close();
      fh = next;
    }
  } catch (err) {
    await fh.close();
    if (refusal(err)) throw new AnchorRefused(dir);
    throw err;
  }
  const self = `/proc/self/fd/${fh.fd}`;
  const held = fh;
  return { self, child: (name) => `${self}/${name}`, close: () => held.close() };
}

async function openDarwin(dir: string): Promise<AnchoredDir> {
  let fh: FileHandle;
  try {
    // Search permission first (all a child lookup needs), then read
    // permission: a readable but unsearchable directory still lists (#285).
    // The handle only pins the inode; each later operation is permission-
    // checked as it would have been by path.
    fh = await fs
      .open(dir, DARWIN_O_SEARCH | DARWIN_O_NOFOLLOW_ANY)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EACCES") throw err;
        return fs.open(dir, fsc.O_RDONLY | fsc.O_DIRECTORY | DARWIN_O_NOFOLLOW_ANY);
      });
  } catch (err) {
    if (refusal(err)) throw new AnchorRefused(dir);
    throw err;
  }
  try {
    const st = await fh.stat({ bigint: true });
    const self = `/.vol/${st.dev}/${st.ino}`;
    // volfs is an APFS/HFS+ feature. On a volume without it the lookup fails
    // or names something else; refuse rather than fall back to the path.
    const viaVol = await fs.stat(self, { bigint: true }).catch(() => null);
    if (viaVol === null || viaVol.ino !== st.ino || viaVol.dev !== st.dev) {
      throw new Error(`cannot anchor ${JSON.stringify(dir)}: its volume does not support /.vol lookups`);
    }
    const held = fh;
    return { self, child: (name) => `${self}/${name}`, close: () => held.close() };
  } catch (err) {
    await fh.close();
    throw err;
  }
}
