/**
 * Atomicity contract for `atomicWriteFile` (#36).
 *
 * `fs.promises.writeFile` is not atomic. The destination is opened
 * with `O_WRONLY | O_CREAT | O_TRUNC` (truncates immediately) and
 * the bytes only commit on completion. If the MCP server is killed
 * mid-write, the destination is left zero-length or partial. Worst
 * shape for an MCP tool: clients re-read what they wrote, so a
 * half-written file corrupts the conversational context.
 *
 * The fix routes `tools.ts::writeFile` (line 97) through
 * `atomicWriteFile`: sibling-tempfile in `path.dirname(target)`
 * with O_EXCL → write → fsync → close → `fs.rename` (atomic on POSIX
 * within the same filesystem; the same-directory placement is
 * load-bearing because cross-filesystem rename degrades to a copy).
 *
 * TypeScript cross-language sibling of the Python atomicity helpers
 * landed in the same session in `llm-eval-harness#48`,
 * `llm-cost-optimizer#42`, `prompt-regression-suite#39`,
 * `rag-production-kit#44`.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWriteFile } from "../src/atomic_write.js";
import { Sandbox } from "../src/sandbox.js";
import { writeFile } from "../src/tools.js";

let workDir: string;
let allowedRoot: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fs-atomic-"));
  allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fs-atomic-root-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(allowedRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function makeDeps(opts: { readOnly?: boolean; maxBytes?: number } = {}) {
  const sandbox = await Sandbox.create([allowedRoot]);
  return {
    sandbox,
    readOnly: opts.readOnly ?? false,
    maxBytes: opts.maxBytes ?? 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// Unit tests on the helper itself.
// ---------------------------------------------------------------------------

describe("atomicWriteFile (helper)", () => {
  it("writes the full contents on a fresh destination", async () => {
    const target = path.join(workDir, "out.txt");
    await atomicWriteFile(target, Buffer.from("hello\nworld\n", "utf-8"));
    expect(await fs.readFile(target, "utf-8")).toBe("hello\nworld\n");
  });

  it("auto-creates parent directories", async () => {
    const target = path.join(workDir, "deep", "nested", "x.json");
    await atomicWriteFile(target, Buffer.from("{}", "utf-8"));
    expect(await fs.readFile(target, "utf-8")).toBe("{}");
  });

  it("replaces an existing destination wholly", async () => {
    const target = path.join(workDir, "exists.txt");
    await fs.writeFile(target, "STALE-MUST-NOT-SURVIVE");
    await atomicWriteFile(target, Buffer.from("fresh", "utf-8"));
    expect(await fs.readFile(target, "utf-8")).toBe("fresh");
  });

  it("leaves the destination absent when fs.rename throws (the load-bearing invariant)", async () => {
    const target = path.join(workDir, "result.json");
    const spy = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(new Error("simulated mid-rename failure"));

    await expect(
      atomicWriteFile(target, Buffer.from('{"k":"v"}', "utf-8")),
    ).rejects.toThrow(/simulated mid-rename failure/);

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("cleans up the temp sibling when fs.rename throws", async () => {
    const target = path.join(workDir, "artifacts", "delta.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated mid-rename failure"));

    await expect(
      atomicWriteFile(target, Buffer.from('{"k":"v"}', "utf-8")),
    ).rejects.toThrow(/simulated mid-rename failure/);

    const siblings = await fs.readdir(path.dirname(target));
    expect(siblings).toEqual([]);
  });

  it("preserves pre-existing destination contents when overwrite rename fails", async () => {
    // The property `fs.writeFile` could never offer: a failed
    // overwrite must leave the on-disk file bitwise unchanged.
    const target = path.join(workDir, "existing.json");
    const original = Buffer.from('{"keep":true}', "utf-8");
    await fs.writeFile(target, original);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated"));

    await expect(
      atomicWriteFile(target, Buffer.from('{"overwrite":true}', "utf-8")),
    ).rejects.toThrow(/simulated/);

    const onDisk = await fs.readFile(target);
    expect(onDisk.equals(original)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: `tools.ts::writeFile` routes through `atomicWriteFile`.
// ---------------------------------------------------------------------------

describe("tools.writeFile atomicity (via atomicWriteFile)", () => {
  it("a failed rename leaves the destination absent through the MCP tool surface", async () => {
    const file = path.join(allowedRoot, "new.txt");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated rename failure"));

    await expect(writeFile(await makeDeps(), file, "hello")).rejects.toThrow(
      /simulated rename failure/,
    );

    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("two awaited writers targeting the same path produce one winner, no corrupt blend", async () => {
    // `O_EXCL` on the temp filename and the rename atomicity together
    // mean that even though both attempts compute distinct sibling
    // temp filenames (random suffix), the rename serializes — the
    // last-winning rename wins wholesale. The on-disk contents must
    // be one of the two writers' payloads in full, never a blend.
    const file = path.join(allowedRoot, "race.txt");
    const a = "x".repeat(2000);
    const b = "y".repeat(2000);
    const deps = await makeDeps();
    await Promise.all([writeFile(deps, file, a), writeFile(deps, file, b)]);
    const final = await fs.readFile(file, "utf-8");
    expect(final === a || final === b).toBe(true);
    expect(final.length).toBe(2000);
  });
});
