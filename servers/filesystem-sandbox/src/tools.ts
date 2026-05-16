/**
 * Filesystem-sandbox MCP tool implementations.
 *
 * Each tool routes its `path` argument through `Sandbox.resolve(...)`
 * before any filesystem syscall. The sandbox layer is what makes the
 * tools safe; the tools themselves are thin glue.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Sandbox, SandboxEscape } from "./sandbox.js";

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

export async function listDirectory(deps: ToolDeps, dir: string): Promise<DirEntry[]> {
  const sp = await deps.sandbox.resolveDir(dir);
  const entries = await fs.readdir(sp.resolved, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const e of entries) {
    let kind: DirEntry["kind"];
    if (e.isFile()) kind = "file";
    else if (e.isDirectory()) kind = "directory";
    else if (e.isSymbolicLink()) kind = "symlink";
    else kind = "other";
    const entry: DirEntry = { name: e.name, kind };
    if (kind === "file") {
      try {
        const stat = await fs.stat(path.join(sp.resolved, e.name));
        entry.size = stat.size;
      } catch {
        // ignore — stat can fail on broken symlinks; we already
        // know the entry type.
      }
    }
    out.push(entry);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readFile(deps: ToolDeps, file: string): Promise<string> {
  const sp = await deps.sandbox.resolveFile(file);
  const stat = await fs.stat(sp.resolved);
  if (stat.size > deps.maxBytes) {
    throw new FileTooLargeError(stat.size, deps.maxBytes);
  }
  // Refuse anything that isn't UTF-8 text — binary files surface as
  // a clear error rather than as garbled bytes inside a JSON tool
  // result. Detection is "decode strict, fail on replacement char".
  const buf = await fs.readFile(sp.resolved);
  const decoder = new TextDecoder("utf-8", { fatal: true });
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
  const data = Buffer.from(content, "utf-8");
  if (data.byteLength > deps.maxBytes) {
    throw new FileTooLargeError(data.byteLength, deps.maxBytes);
  }
  // The file may not exist yet; resolve with `mustExist: false` so
  // the sandbox checks the parent's containment instead.
  const sp = await deps.sandbox.resolve(file, { mustExist: false });
  await fs.writeFile(sp.resolved, data);
  return { bytes_written: data.byteLength };
}

export function isSandboxEscape(err: unknown): err is SandboxEscape {
  return err instanceof SandboxEscape;
}
