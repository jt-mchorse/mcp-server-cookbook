// `Sandbox.create` refuses a bare string for `roots` (#205). A string is
// iterable, so `create("/a")` walked "/" and then "a" against the cwd; when "a"
// existed there the allow-list was ["/", ".../a/"] and /etc/hosts resolved as
// allowed. The shipped server passes a parsed array; a plain-JS library caller
// was not stopped by `string[]`. The Python suite runs the same repro.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Sandbox } from "../src/sandbox.js";

let base: string;
let prevCwd: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "bare-roots-"));
  await fs.mkdir(path.join(base, "a"));
  prevCwd = process.cwd();
  process.chdir(base);
});

afterEach(async () => {
  process.chdir(prevCwd);
  await fs.rm(base, { recursive: true, force: true });
});

describe("Sandbox.create with a bare string (#205)", () => {
  for (const bare of ["/a", "..", ""]) {
    it(`refuses ${JSON.stringify(bare)} before any root is resolved`, async () => {
      const err = await Sandbox.create(bare as unknown as string[]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toContain("would be read one character at a time");
      expect((err as Error).message).toContain(JSON.stringify(bare));
    });
  }

  it("names the working spelling", async () => {
    await expect(Sandbox.create("/a" as unknown as string[])).rejects.toThrow('pass ["/a"]');
  });

  it("the working spelling never puts the filesystem root on the allow-list", async () => {
    const sb = await Sandbox.create([path.join(base, "a")]);
    expect(sb.allowedRoots).toEqual([(await fs.realpath(path.join(base, "a"))) + path.sep]);
    expect(sb.allowedRoots).not.toContain(path.sep);
  });

  it("an array of roots is unchanged", async () => {
    await fs.mkdir(path.join(base, "b"));
    const sb = await Sandbox.create([path.join(base, "a"), path.join(base, "b")]);
    expect(sb.allowedRoots).toHaveLength(2);
  });
});
