/**
 * write_file refuses a directory target, the allow-list root included (#238).
 *
 * `resolve(mustExist: false)` accepts the root itself (`R`, `R/.`, `R/`,
 * `R/sub/..`), and `atomicWriteFile` stages its temp file in the target's
 * PARENT. For the root that is a directory outside the sandbox: a hunt agent
 * measured the caller's bytes written and fsynced there before the rename
 * failed with EISDIR (and an `EACCES … open '<parent>/.root.<n>.tmp'` when the
 * parent was read-only, which also leaked the parent's path). The Python port
 * did the same, with a different OS error.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Sandbox, SandboxEscape } from "../src/sandbox.js";
import { writeFile } from "../src/tools.js";

let parent: string;
let root: string;
let deps: { sandbox: Sandbox; maxBytes: number; readOnly: boolean };

beforeEach(async () => {
  parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "write-dir-")));
  root = path.join(parent, "root");
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  deps = { sandbox: await Sandbox.create([root]), maxBytes: 1024, readOnly: false };
});

afterEach(async () => {
  await fs.rm(parent, { recursive: true, force: true });
});

describe("write_file on a directory (#238)", () => {
  it.each(["", "/.", "/", "/sub/.."])("the root itself (R%s) is refused and nothing lands outside it", async (suffix) => {
    const err = await writeFile(deps, root + suffix, "secret").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxEscape);
    expect((err as SandboxEscape).reason).toBe("not_a_file");
    expect((await fs.readdir(parent)).sort()).toEqual(["root"]);
  });

  it("a subdirectory is refused the same way", async () => {
    const err = await writeFile(deps, path.join(root, "sub"), "x").catch((e: unknown) => e);
    expect((err as SandboxEscape).reason).toBe("not_a_file");
    expect(await fs.readdir(path.join(root, "sub"))).toEqual([]);
  });

  it("a new file and an existing file are still written (control)", async () => {
    await writeFile(deps, path.join(root, "a.txt"), "one");
    await writeFile(deps, path.join(root, "a.txt"), "two");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("two");
  });
});
