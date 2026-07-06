import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extname } from "node:path";

/**
 * Lock the README's `repo_stats` end-to-end example to reality (#91).
 *
 * The example previously published `total_files: 14`, `.ts: 5`, and a
 * `"<none>": 3` bucket for "this server's own directory on a fresh clone" —
 * but there are zero extensionless tracked files, so `<none>` was fabricated
 * (and the other counts were stale). Nothing caught it because no test
 * checked the documented numbers.
 *
 * This asserts the documented `total_files` and `by_ext` histogram match the
 * tracked file set (`git ls-files` = a fresh clone), depth-limited to the
 * example's `--max-depth`. Those fields are content-insensitive, so the lock
 * is stable across edits; only adding/removing/renaming a tracked file (which
 * *should* update the doc) trips it. `total_bytes` is deliberately not locked
 * — it shifts with any content change and the README file's own bytes count
 * toward it, so it's presented as a snapshot, not an asserted exact.
 */

const SERVER_DIR = resolve(__dirname, "..");
const README_PATH = resolve(SERVER_DIR, "README.md");

// The README example runs `repo_stats` with `max_depth: 3`.
const EXAMPLE_MAX_DEPTH = 3;

interface RepoStatsDoc {
  total_files: number;
  by_ext: Record<string, number>;
}

/** Extract the last JSON object in the README that carries a `by_ext` key —
 * the documented `repo_stats` output. */
function documentedRepoStats(): RepoStatsDoc {
  const md = readFileSync(README_PATH, "utf-8");
  const blocks = [...md.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of blocks.reverse()) {
    if (!block || !block.includes("by_ext")) continue;
    const parsed = JSON.parse(block) as RepoStatsDoc;
    if (parsed.by_ext && typeof parsed.total_files === "number") return parsed;
  }
  throw new Error("no documented repo_stats JSON (with by_ext) found in README");
}

/** Compute total_files + by_ext over the tracked files (a fresh clone),
 * mirroring repo-stats' extension logic and the example's depth cap. */
function freshCloneStats(): RepoStatsDoc {
  const tracked = execFileSync("git", ["ls-files"], { cwd: SERVER_DIR, encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter((p) => p.length > 0)
    // repo-stats walks from the server root; the example caps at max_depth 3,
    // so a path is in-scope when its directory nesting is < max_depth.
    .filter((p) => p.split("/").length <= EXAMPLE_MAX_DEPTH);

  const byExt: Record<string, number> = {};
  for (const p of tracked) {
    const ext = extname(p).toLowerCase() || "<none>";
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(byExt).sort()) sorted[k] = byExt[k] as number;
  return { total_files: tracked.length, by_ext: sorted };
}

describe("README repo_stats example matches the tracked files (#91)", () => {
  it("documented total_files matches a fresh clone", () => {
    expect(documentedRepoStats().total_files).toBe(freshCloneStats().total_files);
  });

  it("documented by_ext histogram matches a fresh clone (no fabricated buckets)", () => {
    expect(documentedRepoStats().by_ext).toEqual(freshCloneStats().by_ext);
  });
});
