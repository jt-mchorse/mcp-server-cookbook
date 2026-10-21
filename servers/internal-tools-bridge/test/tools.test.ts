import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REPO_STATS_BIN,
  ToolInputError,
  defaultBridgeConfig,
  repoStats,
  validateRepoStatsInput,
} from "../src/tools.js";

describe("validateRepoStatsInput", () => {
  it("requires the input to be an object", () => {
    expect(() => validateRepoStatsInput(null)).toThrow(ToolInputError);
    expect(() => validateRepoStatsInput("x")).toThrow(ToolInputError);
    expect(() => validateRepoStatsInput(42)).toThrow(ToolInputError);
  });

  it("requires a non-empty `path`", () => {
    expect(() => validateRepoStatsInput({})).toThrow(/path/);
    expect(() => validateRepoStatsInput({ path: "" })).toThrow(/path/);
    expect(() => validateRepoStatsInput({ path: 42 })).toThrow(/path/);
  });

  it("rejects a NUL byte in `path`", () => {
    expect(() => validateRepoStatsInput({ path: "a\0b" })).toThrow(/NUL/);
  });

  it("accepts a missing max_depth", () => {
    const v = validateRepoStatsInput({ path: "/tmp" });
    expect(v.path).toBe("/tmp");
    expect(v.max_depth).toBeUndefined();
  });

  it("rejects max_depth that isn't an integer in [1, 10]", () => {
    expect(() =>
      validateRepoStatsInput({ path: "/tmp", max_depth: 0 }),
    ).toThrow(/max_depth/);
    expect(() =>
      validateRepoStatsInput({ path: "/tmp", max_depth: 11 }),
    ).toThrow(/max_depth/);
    expect(() =>
      validateRepoStatsInput({ path: "/tmp", max_depth: 2.5 }),
    ).toThrow(/max_depth/);
    expect(() =>
      validateRepoStatsInput({ path: "/tmp", max_depth: "3" }),
    ).toThrow(/max_depth/);
  });

  it("accepts a valid max_depth", () => {
    const v = validateRepoStatsInput({ path: "/tmp", max_depth: 5 });
    expect(v.max_depth).toBe(5);
  });
});

describe("repoStats — end to end against the real CLI", () => {
  it("walks a known fixture and returns the expected shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-stats-"));
    await writeFile(join(root, "a.ts"), "x".repeat(10), "utf-8");
    await writeFile(join(root, "b.ts"), "y".repeat(20), "utf-8");
    await writeFile(join(root, "c.md"), "z".repeat(5), "utf-8");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "d.ts"), "q".repeat(7), "utf-8");

    const out = await repoStats(defaultBridgeConfig(process.cwd()), {
      path: root,
      max_depth: 4,
    });

    expect(out.total_files).toBe(4);
    expect(out.total_bytes).toBe(10 + 20 + 5 + 7);
    expect(out.by_ext[".ts"]).toBe(3);
    expect(out.by_ext[".md"]).toBe(1);
    expect(out.root).toBe(root);
  });

  it("max_depth=1 limits recursion to the root level", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-stats-shallow-"));
    await writeFile(join(root, "top.ts"), "a", "utf-8");
    await mkdir(join(root, "deep"));
    await writeFile(join(root, "deep", "buried.ts"), "b", "utf-8");

    const out = await repoStats(defaultBridgeConfig(process.cwd()), {
      path: root,
      max_depth: 1,
    });

    expect(out.total_files).toBe(1);
    expect(out.by_ext[".ts"]).toBe(1);
  });

  it("propagates the non-existent path as a tool error from the CLI", async () => {
    // CLI exits non-zero with stderr; the bridge surfaces NonZeroExitError
    // and the server's catch block turns that into a tool error response.
    await expect(
      repoStats(defaultBridgeConfig(process.cwd()), {
        path: "/this/path/does/not/exist/" + Math.random(),
      }),
    ).rejects.toThrow();
  });
});

describe("repo-stats CLI: --max-depth is a plain integer, not a parseInt prefix (#318)", () => {
  // Direct CLI use only -- the bridge always passes `String(int)`. The tree is
  // two levels deep so a value that ran as 1 is visible in `total_files`.
  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "repo-stats-depth-"));
    await writeFile(join(root, "top.ts"), "a", "utf-8");
    await mkdir(join(root, "deep"));
    await writeFile(join(root, "deep", "buried.ts"), "b", "utf-8");
    return root;
  }

  function run(root: string, depth: string) {
    return spawnSync(process.execPath, [REPO_STATS_BIN, "--root", root, "--max-depth", depth], {
      encoding: "utf-8",
    });
  }

  // `parseInt` read a prefix of each of these and ran with it, exit 0.
  it.each(["2abc", "1e1", "3.9", "0x5"])("refuses %s with exit 2", async (depth) => {
    const res = run(await fixture(), depth);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--max-depth must be an integer in [1, 10]");
  });

  // Controls: both ends of the range still run.
  it.each([
    ["10", 2],
    ["1", 1],
  ])("accepts %s", async (depth, files) => {
    const res = run(await fixture(), depth);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).total_files).toBe(files);
  });
});

describe("REPO_STATS_BIN constant", () => {
  it("resolves to a path that ends in bin/repo-stats.mjs", () => {
    expect(REPO_STATS_BIN.endsWith("bin/repo-stats.mjs")).toBe(true);
  });
});
