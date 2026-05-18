// Tool handlers for internal-tools-bridge.
//
// Each handler validates structured args, converts them to an argv
// array, and runs the allow-listed binary via the bridge. Inputs that
// fail validation throw a typed `ToolInputError`; the server's catch
// block turns that into an isError MCP response.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import { runBridged, type BridgeConfig, BridgeError } from "./bridge.js";

export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the bundled CLI. Lives in `<server>/bin/repo-stats.mjs`. */
export const REPO_STATS_BIN = resolvePath(__dirname, "..", "bin", "repo-stats.mjs");

/** Node binary used to invoke the CLI. */
export const NODE_BIN = process.execPath;

export function defaultBridgeConfig(cwd: string): BridgeConfig {
  return {
    allowlist: [NODE_BIN],
    cwd,
    timeoutMs: 10_000,
  };
}

export interface RepoStatsInput {
  readonly path: string;
  readonly max_depth?: number;
}

export interface RepoStatsOutput {
  readonly root: string;
  readonly total_files: number;
  readonly total_bytes: number;
  readonly by_ext: Record<string, number>;
}

export function validateRepoStatsInput(raw: unknown): RepoStatsInput {
  if (raw === null || typeof raw !== "object") {
    throw new ToolInputError("input must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.path !== "string" || o.path.length === 0) {
    throw new ToolInputError("`path` is required and must be a non-empty string");
  }
  if (o.path.includes("\0")) {
    throw new ToolInputError("`path` must not contain a NUL byte");
  }
  let maxDepth: number | undefined;
  if (o.max_depth !== undefined) {
    if (typeof o.max_depth !== "number" || !Number.isInteger(o.max_depth)) {
      throw new ToolInputError("`max_depth` must be an integer");
    }
    if (o.max_depth < 1 || o.max_depth > 10) {
      throw new ToolInputError("`max_depth` must be in [1, 10]");
    }
    maxDepth = o.max_depth;
  }
  return { path: o.path, max_depth: maxDepth };
}

export async function repoStats(
  cfg: BridgeConfig,
  raw: unknown,
): Promise<RepoStatsOutput> {
  const input = validateRepoStatsInput(raw);
  const args = ["--", REPO_STATS_BIN, "--root", input.path];
  if (input.max_depth !== undefined) {
    args.push("--max-depth", String(input.max_depth));
  }
  let result;
  try {
    result = await runBridged(cfg, NODE_BIN, args);
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new BridgeError(
      `repo-stats output was not JSON; first 200 chars: ${result.stdout.slice(0, 200)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BridgeError("repo-stats output was not a JSON object");
  }
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.root !== "string" ||
    typeof p.total_files !== "number" ||
    typeof p.total_bytes !== "number" ||
    typeof p.by_ext !== "object" ||
    p.by_ext === null
  ) {
    throw new BridgeError("repo-stats output did not match expected shape");
  }
  return {
    root: p.root,
    total_files: p.total_files,
    total_bytes: p.total_bytes,
    by_ext: p.by_ext as Record<string, number>,
  };
}
