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
      const n = Number.parseInt(argv[++i], 10);
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

async function walk(root, maxDepth) {
  const byExt = new Map();
  let totalFiles = 0;
  let totalBytes = 0;

  async function recurse(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory — silently skip; the count is honest.
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
  } catch {
    process.stderr.write(`--root does not exist: ${absRoot}\n`);
    process.exit(2);
  }
  const out = await walk(absRoot, args.maxDepth);
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
