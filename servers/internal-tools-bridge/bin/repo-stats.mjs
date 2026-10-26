#!/usr/bin/env node
// Sample internal CLI wrapped by the internal-tools-bridge MCP server.
// Stdlib-only Node ESM. Walks a directory and reports file counts by
// extension plus total bytes. Output is one JSON object on stdout.
//
// Usage:
//   node bin/repo-stats.mjs --root <path> [--max-depth <N>]
//
// --root      required; resolved relative to the process cwd.
// --max-depth optional integer in [1, 10]; defaults to 4.
//
// Exits 0 on success with JSON on stdout, 2 on input error with the
// message on stderr. No network, no spawn, no env reads beyond what
// stdlib needs to traverse the filesystem.

import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const DEFAULT_MAX_DEPTH = 4;
const ABSOLUTE_MAX_DEPTH = 10;

function parseArgs(argv) {
  const args = { root: null, maxDepth: DEFAULT_MAX_DEPTH };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--root") {
      args.root = argv[++i];
    } else if (flag === "--max-depth") {
      // Gate on plain digits BEFORE coercing (#318). `Number.parseInt` stops
      // at the first character it cannot consume, so `2abc` ran as 2, `1e1`
      // as 1 (not 10) and `3.9` as 3 -- the parseInt shape #152/#154 removed
      // from the servers' env and header parsing. This script is stdlib-only
      // and standalone, so the grammar is inlined rather than imported.
      const raw = argv[++i];
      const n = typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(n) || n < 1 || n > ABSOLUTE_MAX_DEPTH) {
        throw new Error(`--max-depth must be an integer in [1, ${ABSOLUTE_MAX_DEPTH}]`);
      }
      args.maxDepth = n;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (args.help) return args;
  if (!args.root) throw new Error("--root is required");
  return args;
}

class RootUnreadableError extends Error {
  constructor(root, cause) {
    super(`--root is not readable: ${root}${errnoSuffix(cause)}`);
  }
}

/** ` (EACCES)` for a Node fs error, else nothing: the code, never the message. */
function errnoSuffix(e) {
  return e && typeof e.code === "string" ? ` (${e.code})` : "";
}

async function walk(root, maxDepth) {
  const byExt = new Map();
  let totalFiles = 0;
  let totalBytes = 0;

  async function recurse(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      // The root itself unreadable is an input error, not an empty tree
      // (#341): skipping it answered `total_files: 0`, exit 0, the same as an
      // empty directory. Thrown for `main` to report, beside the missing and
      // non-directory roots it already refuses.
      if (depth === 1) throw new RootUnreadableError(root, e);
      // A nested unreadable directory is skipped; the rest of the tree is still
      // counted. (Surfacing it would change the output shape: a separate call.)
      return;
    }
    // Sort entries deterministically so output is stable for the same tree.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue; // don't traverse symlinks
      if (e.isDirectory()) {
        await recurse(p, depth + 1);
      } else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase() || "<none>";
        byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
        totalFiles += 1;
        try {
          const s = await stat(p);
          totalBytes += s.size;
        } catch {
          // Unreadable file — count stays honest at 0 bytes added.
        }
      }
    }
  }

  await recurse(root, 1);

  // Sort byExt for deterministic JSON serialization.
  const byExtObj = {};
  for (const k of [...byExt.keys()].sort()) byExtObj[k] = byExt.get(k);

  return { root, total_files: totalFiles, total_bytes: totalBytes, by_ext: byExtObj };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(
      "Usage: repo-stats --root <path> [--max-depth <1..10>]\n",
    );
    return;
  }
  const absRoot = resolve(args.root);
  try {
    const s = await stat(absRoot);
    if (!s.isDirectory()) {
      process.stderr.write(`--root is not a directory: ${absRoot}\n`);
      process.exit(2);
    }
  } catch (e) {
    // A permission failure is not "does not exist" (#341): a root under a
    // directory the process cannot search fails `stat` with EACCES, and was
    // reported as missing while it was there. Every other failure (ENOENT,
    // ENOTDIR, ENAMETOOLONG, ...) keeps the message it always had.
    const denied = e && (e.code === "EACCES" || e.code === "EPERM");
    process.stderr.write(
      denied
        ? `--root is not readable: ${absRoot}${errnoSuffix(e)}\n`
        : `--root does not exist: ${absRoot}\n`,
    );
    process.exit(2);
  }
  let out;
  try {
    out = await walk(absRoot, args.maxDepth);
  } catch (e) {
    if (!(e instanceof RootUnreadableError)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
