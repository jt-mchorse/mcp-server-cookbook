import { describe, expect, it } from "vitest";
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

describe("REPO_STATS_BIN constant", () => {
  it("resolves to a path that ends in bin/repo-stats.mjs", () => {
    expect(REPO_STATS_BIN.endsWith("bin/repo-stats.mjs")).toBe(true);
  });
});
