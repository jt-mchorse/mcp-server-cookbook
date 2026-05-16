/**
 * Filesystem sandbox: every input path is resolved against an
 * allow-list of canonical roots before any file syscall touches it.
 *
 * Threat model (mirrored in this server's README):
 *
 * - **Protects against.** A misbehaving (or attacker-controlled) MCP
 *   client asking the server to read or write outside the allow-list.
 *   Path-traversal (`../../../etc/passwd`), absolute paths outside
 *   roots, symlinks pointing outside, null-byte injection, and
 *   carriage-return / control-character smuggling all surface as
 *   `SandboxEscape` errors *before* any IO.
 * - **Does not protect against.** Resource exhaustion (giant reads,
 *   write storms), denial-of-service, or the client *legitimately*
 *   reading files inside the allow-list it shouldn't. Out-of-scope
 *   here; downstream layers handle quota/rate-limit/audit.
 *
 * Implementation notes:
 *
 * 1. Roots are resolved to their canonical (symlink-followed) real
 *    path once, at construction. A symlinked allow-list root is
 *    fine; the *resolved* target is what's checked.
 * 2. Per-call resolution uses `fs.realpath` (follows symlinks) so a
 *    symlink under the allow-list pointing outside *must not*
 *    succeed (D-006).
 * 3. Containment check is a `<root>/` prefix match on the resolved
 *    path. The trailing slash matters: `/tmp/foo` must not match
 *    `/tmp/foobar` as a substring; `/tmp/foo/` does.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type SandboxEscapeReason =
  | "input_empty"
  | "input_null_byte"
  | "input_control_char"
  | "input_relative_disallowed"
  | "outside_allowlist"
  | "symlink_outside_allowlist"
  | "root_does_not_exist"
  | "not_a_file"
  | "not_a_directory";

export class SandboxEscape extends Error {
  readonly reason: SandboxEscapeReason;
  readonly input: string;
  constructor(reason: SandboxEscapeReason, input: string, message?: string) {
    super(message ?? `${reason}: ${JSON.stringify(input)}`);
    this.reason = reason;
    this.input = input;
    this.name = "SandboxEscape";
  }
}

export interface SandboxedPath {
  /** The canonical, symlink-resolved absolute path. */
  resolved: string;
  /** Which allow-list root this resolved path belongs to. */
  root: string;
}

export class Sandbox {
  /** Resolved allow-list roots, each ending with the platform separator. */
  private readonly roots: string[];

  static async create(roots: string[]): Promise<Sandbox> {
    if (roots.length === 0) {
      throw new Error(
        "Sandbox requires at least one allow-list root. " +
          "Empty allow-list would mean every path is rejected — that's a config bug, not a useful sandbox state.",
      );
    }
    const resolved: string[] = [];
    for (const r of roots) {
      const real = await realpathOrThrow(r);
      const withSep = real.endsWith(path.sep) ? real : real + path.sep;
      resolved.push(withSep);
    }
    return new Sandbox(resolved);
  }

  private constructor(resolvedRoots: string[]) {
    this.roots = resolvedRoots;
  }

  /** Returns the resolved roots (read-only view for diagnostics). */
  get allowedRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Resolve `input` against the allow-list. Throws `SandboxEscape` on
   * any rejection; returns the `SandboxedPath` otherwise.
   *
   * `mustExist=false` lets writes target a path that doesn't exist
   * yet (the parent directory must exist + be in the allow-list).
   */
  async resolve(input: string, opts: { mustExist?: boolean } = {}): Promise<SandboxedPath> {
    _validateInput(input);
    if (!path.isAbsolute(input)) {
      throw new SandboxEscape(
        "input_relative_disallowed",
        input,
        "input path must be absolute; relative paths are rejected to avoid CWD-dependent surprises",
      );
    }

    const mustExist = opts.mustExist ?? true;
    let real: string;
    if (mustExist) {
      try {
        real = await fs.realpath(input);
      } catch {
        // The path doesn't exist; treat as outside-allowlist since we
        // can't prove containment without a realpath. Callers that
        // want to create a new file pass `mustExist: false`.
        throw new SandboxEscape("outside_allowlist", input);
      }
    } else {
      // Resolve the parent's realpath, then rejoin the basename. This
      // catches `parent` symlinks pointing outside even when the leaf
      // doesn't exist yet.
      const parent = path.dirname(input);
      let parentReal: string;
      try {
        parentReal = await fs.realpath(parent);
      } catch {
        throw new SandboxEscape("outside_allowlist", input);
      }
      real = path.join(parentReal, path.basename(input));
    }

    for (const root of this.roots) {
      if (_underRoot(real, root)) {
        return { resolved: real, root };
      }
    }
    throw new SandboxEscape("outside_allowlist", input);
  }

  /** Convenience: resolve and assert the path is a directory. */
  async resolveDir(input: string): Promise<SandboxedPath> {
    const sp = await this.resolve(input);
    const stat = await fs.stat(sp.resolved);
    if (!stat.isDirectory()) {
      throw new SandboxEscape("not_a_directory", input);
    }
    return sp;
  }

  /** Convenience: resolve and assert the path is a regular file. */
  async resolveFile(input: string): Promise<SandboxedPath> {
    const sp = await this.resolve(input);
    const stat = await fs.stat(sp.resolved);
    if (!stat.isFile()) {
      throw new SandboxEscape("not_a_file", input);
    }
    return sp;
  }
}

function _validateInput(input: string): void {
  if (typeof input !== "string" || input.length === 0) {
    throw new SandboxEscape("input_empty", input);
  }
  if (input.includes("\0")) {
    throw new SandboxEscape("input_null_byte", input);
  }
  // Reject other ASCII control characters (0x01-0x1f, 0x7f) — they
  // have no place in a filesystem path, and rejecting them prevents
  // log-injection / terminal-escape shenanigans downstream.
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0) continue; // already caught above
    if (code < 0x20 || code === 0x7f) {
      throw new SandboxEscape("input_control_char", input);
    }
  }
}

function _underRoot(resolved: string, rootWithSep: string): boolean {
  // The root already has a trailing path.sep; the resolved path's
  // exact equality to root (sans trailing sep) is also valid.
  const rootNoSep = rootWithSep.slice(0, -1);
  return resolved === rootNoSep || resolved.startsWith(rootWithSep);
}

async function realpathOrThrow(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    throw new SandboxEscape(
      "root_does_not_exist",
      p,
      `allow-list root does not exist: ${p} (${(err as Error).message})`,
    );
  }
}
