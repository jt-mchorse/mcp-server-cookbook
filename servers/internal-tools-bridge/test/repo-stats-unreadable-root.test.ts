/**
 * An unreadable `--root` is an input error, not an empty tree (#341).
 *
 * `walk`'s `readdir` catch skipped an unreadable directory, which is right for
 * a nested one but made an unreadable ROOT answer success with zero files.
 * Measured on main beb8a59 (macOS, a root holding 2 files, `chmod 000`):
 *
 *     node bin/repo-stats.mjs --root rs/locked  -> {"total_files":0,...}  exit 0
 *     repoStats(cfg, {path:"rs/locked"})        -> OK, identical to an empty dir
 *
 * The same root half had a second shape: a root under a directory the process
 * cannot search fails `stat` with EACCES, and was reported as "does not exist".
 *
 * The chmod arms are skipped as root (permissions do not stop root) and on
 * Windows (where `chmod` does not remove read access).
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NonZeroExitError } from "../src/bridge.js";
import { REPO_STATS_BIN, defaultBridgeConfig, repoStats } from "../src/tools.js";

const permissionsBite = process.platform !== "win32" && process.getuid?.() !== 0;

/** Directories this file made unreadable, restored so the temp tree can be removed. */
const locked: string[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const dir of locked.splice(0)) await chmod(dir, 0o755);
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repo-stats-unreadable-"));
  roots.push(root);
  return root;
}

async function lock(dir: string, mode = 0o000): Promise<void> {
  await chmod(dir, mode);
  locked.push(dir);
}

function cli(root: string) {
  return spawnSync(process.execPath, [REPO_STATS_BIN, "--root", root], { encoding: "utf-8" });
}

describe.skipIf(!permissionsBite)("an unreadable --root exits 2 (#341)", () => {
  it("via the CLI, naming the root and the errno", async () => {
    const base = await tree();
    const root = join(base, "locked");
    await mkdir(root);
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.md"), "bb");
    await lock(root);

    const r = cli(root);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`--root is not readable: ${root} (EACCES)\n`);
  });

  it("via the bridge repo_stats tool, as a non-zero exit rather than zero files", async () => {
    const base = await tree();
    const root = join(base, "locked");
    await mkdir(root);
    await writeFile(join(root, "a.txt"), "a");
    await lock(root);

    const err = await repoStats(defaultBridgeConfig(process.cwd()), { path: root }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonZeroExitError);
    expect((err as NonZeroExitError).exitCode).toBe(2);
    expect((err as NonZeroExitError).stderr).toContain("--root is not readable");
  });

  it("a root under an unsearchable directory is not reported as missing", async () => {
    const base = await tree();
    const parent = join(base, "noexec");
    await mkdir(join(parent, "child"), { recursive: true });
    await lock(parent, 0o600);

    const r = cli(join(parent, "child"));
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(`--root is not readable: ${join(parent, "child")} (EACCES)\n`);
  });

  it("a nested unreadable directory is still skipped and its siblings counted (control)", async () => {
    const root = await tree();
    await writeFile(join(root, "top.txt"), "x");
    await mkdir(join(root, "inner"));
    await writeFile(join(root, "inner", "z.txt"), "y");
    await lock(join(root, "inner"));

    const r = cli(root);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ root, total_files: 1, total_bytes: 1, by_ext: { ".txt": 1 } });
  });
});

describe("the other root answers are unchanged (#341 controls)", () => {
  it("an empty root is still zero files, exit 0", async () => {
    const root = await tree();
    const r = cli(root);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ root, total_files: 0, total_bytes: 0, by_ext: {} });
  });

  it("a missing root still says it does not exist", async () => {
    const root = join(await tree(), "missing");
    const r = cli(root);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(`--root does not exist: ${root}\n`);
  });

  it("a root below a file is reported as missing, not unreadable", async () => {
    const base = await tree();
    await writeFile(join(base, "f.txt"), "x");
    const r = cli(join(base, "f.txt", "x"));
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(`--root does not exist: ${join(base, "f.txt", "x")}\n`);
  });

  it("a file root is still not a directory", async () => {
    const base = await tree();
    await writeFile(join(base, "f.txt"), "x");
    const r = cli(join(base, "f.txt"));
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(`--root is not a directory: ${join(base, "f.txt")}\n`);
  });
});
