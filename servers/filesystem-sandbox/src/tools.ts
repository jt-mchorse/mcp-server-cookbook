/**
 * Filesystem-sandbox MCP tool implementations.
 *
 * Each tool routes its `path` argument through `Sandbox.resolve(...)`
 * before any filesystem syscall. The sandbox layer is what makes the
 * tools safe; the tools themselves are thin glue.
 */

import { promises as fs, constants as fsc } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { AnchorRefused, openAnchoredDir, type AnchoredDir } from "./anchored.js";
import { atomicWriteFile } from "./atomic_write.js";
import { Sandbox, SandboxEscape, type SandboxedPath } from "./sandbox.js";

export interface ToolDeps {
  sandbox: Sandbox;
  readOnly: boolean;
  maxBytes: number;
}

export class WriteForbiddenError extends Error {
  constructor() {
    super("write_file is disabled (MCP_FS_SANDBOX_READ_ONLY=1)");
    this.name = "WriteForbiddenError";
  }
}

export class FileTooLargeError extends Error {
  constructor(public readonly size: number, public readonly limit: number) {
    super(`file size ${size} > limit ${limit} bytes`);
    this.name = "FileTooLargeError";
  }
}

export interface DirEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number;
}

/** The allow-list root `sp` belongs to, without its trailing separator. */
function rootDir(sp: SandboxedPath): string {
  return sp.root.length > 1 ? sp.root.slice(0, -1) : sp.root;
}

/**
 * Hold `dir` open beneath `sp`'s root, refusing a symlink at any component
 * (#233). `resolve` checked the realpath; this is what makes the IO that
 * follows use the directory it checked, not whatever the path names by then.
 * `null` where the platform cannot anchor (see `anchored.ts`).
 */
async function anchor(sp: SandboxedPath, dir: string, input: string): Promise<AnchoredDir | null> {
  try {
    return await openAnchoredDir(rootDir(sp), dir);
  } catch (err) {
    if (err instanceof AnchorRefused) throw new SandboxEscape("outside_allowlist", input);
    throw err;
  }
}

export async function listDirectory(deps: ToolDeps, dir: string): Promise<DirEntry[]> {
  const sp = await deps.sandbox.resolveDir(dir);
  // Through the held directory (#233): `readdir(sp.resolved)` listed whatever
  // a swapped-in symlink pointed at, and the per-entry stat sized its files.
  const anchored = await anchor(sp, sp.resolved, dir);
  try {
    return await listAnchored(anchored, sp.resolved);
  } finally {
    await anchored?.close();
  }
}

async function listAnchored(anchored: AnchoredDir | null, resolved: string): Promise<DirEntry[]> {
  const at = anchored ? anchored.self : resolved;
  const child = (name: string) => (anchored ? anchored.child(name) : path.join(resolved, name));
  const entries = await fs.readdir(at, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const e of entries) {
    let kind: DirEntry["kind"];
    if (e.isFile()) kind = "file";
    else if (e.isDirectory()) kind = "directory";
    else if (e.isSymbolicLink()) kind = "symlink";
    else kind = "other";
    const entry: DirEntry = { name: e.name, kind };
    if (kind === "file") {
      // `lstat` (#233): the entry was a file when listed; if it has been
      // swapped for a symlink since, its own size is the honest answer, not
      // the size of whatever it points at.
      try {
        const stat = await fs.lstat(child(e.name));
        entry.size = stat.size;
      } catch {
        // ignore — the entry may be gone by now; we already know its type.
      }
    }
    out.push(entry);
  }
  // By code point, as Python's `sorted` does (#209). `localeCompare` made the
  // order depend on the HOST locale (`ä` first under en_US, last under sv_SE)
  // and disagree with the Python port even on ASCII (`_x,a,B` vs `B,Z,_x`).
  out.sort((a, b) => compareCodePoints(a.name, b.name));
  return out;
}

/**
 * Order two strings by Unicode code point -- Python's `str` ordering.
 *
 * Not `<`: JavaScript compares UTF-16 code units, which puts an astral
 * character (a surrogate pair, 0xD800-0xDBFF) before U+E000-U+FFFF while code
 * point order puts it after.
 */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

/**
 * The first lone surrogate in `s` as `[codePointIndex, codeUnit]`, or `null`.
 *
 * The index counts code points, so it matches the `position` Python's UTF-8
 * codec reports for the same string.
 */
function firstLoneSurrogate(s: string): [number, number] | null {
  let index = 0;
  for (const ch of s) {
    const cu = ch.charCodeAt(0);
    if (ch.length === 1 && cu >= 0xd800 && cu <= 0xdfff) return [index, cu];
    index += 1;
  }
  return null;
}

/** Largest single buffer `readFile` allocates, and largest single `read()` (#279). */
export const READ_CHUNK_BYTES = 1_048_576;

export async function readFile(deps: ToolDeps, file: string): Promise<string> {
  const sp = await deps.sandbox.resolveFile(file);
  // One handle for the size check AND the read, and the read itself bounded
  // (#232). This was `fs.stat(path)`, then `fs.readFile(path)`: a file growing
  // in between was returned whole -- 1205 of 2211 reads past a 1 KiB cap,
  // up to 4.7 MB. Reading at most `maxBytes + 1` through the handle makes the
  // cap hold whatever the file does meanwhile.
  //
  // Opened through the held parent and `O_NOFOLLOW` (#233), so the file is the
  // one `resolveFile` checked even if a component was swapped for a symlink
  // since. `O_NONBLOCK` so a leaf swapped for a FIFO cannot block the open;
  // the type check below then refuses it.
  const dir = await anchor(sp, path.dirname(sp.resolved), file);
  let fh: FileHandle;
  try {
    fh = await fs.open(
      dir ? dir.child(path.basename(sp.resolved)) : sp.resolved,
      fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SandboxEscape("outside_allowlist", file);
    }
    throw err;
  } finally {
    await dir?.close();
  }
  let buf: Buffer;
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) {
      throw new SandboxEscape("not_a_file", file);
    }
    if (stat.size > deps.maxBytes) {
      throw new FileTooLargeError(stat.size, deps.maxBytes);
    }
    // Read UP TO `maxBytes + 1`, in chunks, rather than into one buffer of
    // that size (#279). The cap is an upper bound, not an allocation: one
    // `maxBytes + 1` buffer made a 5-byte read of a file allocate the whole
    // cap, and a single `read()` length must fit an int32, so a cap of
    // 2**31 - 1 or more (which the config accepts, up to MAX_SAFE_INTEGER, the
    // parity contract of #137) aborted the process on Node 22+ and failed
    // every read on Node 20.
    const limit = deps.maxBytes + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < limit) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, limit - total));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > deps.maxBytes) {
      throw new FileTooLargeError(total, deps.maxBytes);
    }
    buf = Buffer.concat(chunks, total);
  } finally {
    await fh.close();
  }
  // Refuse anything that isn't UTF-8 text — binary files surface as
  // a clear error rather than as garbled bytes inside a JSON tool
  // result. Detection is "decode strict, fail on replacement char".
  // `ignoreBOM: true` KEEPS a leading U+FEFF (#209). The default strips it, so
  // this port returned "hello" where the Python port returns "\ufeffhello", and
  // a read-then-write here silently dropped the BOM.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    return decoder.decode(buf);
  } catch {
    throw new Error(`file is not valid UTF-8 text: ${file}`);
  }
}

export async function writeFile(
  deps: ToolDeps,
  file: string,
  content: string,
): Promise<{ bytes_written: number }> {
  if (deps.readOnly) throw new WriteForbiddenError();
  // Type-guard `content` before encoding. The handler casts
  // `a.content as string` with no runtime validation and the SDK doesn't
  // enforce inputSchema types, so a present-but-non-string reaches here. Without
  // this, a number/object/bool hits `Buffer.from(x, "utf-8")` and throws a raw
  // TypeError, and — worse — an ARRAY like [1,2,3] silently writes raw bytes and
  // reports success. Mirrors the `path` typeof contract (sandbox `_validateInput`)
  // and the github-gists `content` guard (#119, sibling of #117).
  if (typeof content !== "string") {
    throw new Error("content must be a string");
  }
  // A lone surrogate has no UTF-8 encoding. `Buffer.from` wrote U+FFFD in its
  // place and the call reported success -- silent corruption (#209). Refused
  // here with the exact message the Python port's codec raises, before any byte
  // is written.
  const lone = firstLoneSurrogate(content);
  if (lone !== null) {
    const [position, cu] = lone;
    throw new Error(
      `'utf-8' codec can't encode character '\\u${cu.toString(16).padStart(4, "0")}' ` +
        `in position ${position}: surrogates not allowed`,
    );
  }
  const data = Buffer.from(content, "utf-8");
  if (data.byteLength > deps.maxBytes) {
    throw new FileTooLargeError(data.byteLength, deps.maxBytes);
  }
  // The file may not exist yet; resolve with `mustExist: false` so
  // the sandbox checks the parent's containment instead.
  const sp = await deps.sandbox.resolve(file, { mustExist: false });
  // A directory is not a writable file, and the allow-list root is one (#238).
  // `resolve` accepts the root itself (`R`, `R/.`, `R/`, `R/sub/..`), and
  // `atomicWriteFile` stages its temp file in the target's PARENT -- for the
  // root, a directory outside the sandbox -- so the caller's bytes were written
  // and fsynced outside it before the rename failed with EISDIR. Refused here,
  // before any filesystem write, with the same reason the read path uses.
  if (sp.resolved === rootDir(sp)) {
    throw new SandboxEscape("not_a_file", file);
  }
  // Everything below goes through the held parent (#233): the directory
  // check, the temp file, the mode copy and the rename. By path, a parent
  // swapped for a symlink after `resolve` put the bytes outside the root.
  const dir = await anchor(sp, path.dirname(sp.resolved), file);
  try {
    const leaf = dir ? dir.child(path.basename(sp.resolved)) : sp.resolved;
    const existing = await fs.lstat(leaf).catch(() => null);
    if (existing?.isDirectory()) {
      throw new SandboxEscape("not_a_file", file);
    }
    await atomicWriteFile(sp.resolved, data, dir ?? undefined);
  } finally {
    await dir?.close();
  }
  return { bytes_written: data.byteLength };
}

export function isSandboxEscape(err: unknown): err is SandboxEscape {
  return err instanceof SandboxEscape;
}

/**
 * Stringify a tool error for the MCP response.
 *
 * Byte-identical to the Python port's `_error_message`, pinned by the shared
 * table in `test-fixtures/error_message_parity.json` (#148, D-010). This is the
 * only parity surface a client actually reads; the other four shared tables
 * cover internals. Before #148 all four arms diverged, and the Python side
 * repeated the reason (`sandbox_escape (outside_allowlist): outside_allowlist:
 * '/etc/passwd'`) because `SandboxEscape.__init__` already puts it in the
 * message.
 *
 * The input is JSON-quoted rather than interpolated raw. An unquoted path
 * carrying a space, a trailing separator, or a NUL is ambiguous in a refusal
 * message, and ambiguity is exactly what a sandbox refusal must not have.
 * `JSON.stringify` and Python's `json.dumps(..., ensure_ascii=False)` agree on
 * eight of nine awkward codepoints; the ninth is a lone surrogate, which the
 * Python port escapes the way ES2019's well-formed `JSON.stringify` does (#163).
 * Over stdio the two ports still answer such a request differently: this port
 * returns the refusal below, and the Python port answers with a JSON-RPC error
 * (-32602), because its SDK transport rejects the line before any tool runs
 * (#210, D-015).
 *
 * The typed errors' messages are already safe to show: they never echo
 * allow-list contents or absolute paths beyond what the caller supplied.
 */
export function errorMessage(err: unknown): string {
  if (isSandboxEscape(err)) {
    return `sandbox_escape (${err.reason}): ${JSON.stringify(err.input)}`;
  }
  if (err instanceof WriteForbiddenError) return err.message;
  if (err instanceof FileTooLargeError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
