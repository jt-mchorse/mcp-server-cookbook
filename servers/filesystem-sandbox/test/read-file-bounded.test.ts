/**
 * read_file's cap holds even when the file grows during the call (#232).
 *
 * The size was checked with `fs.stat(path)` and the file then read whole with
 * `fs.readFile(path)`: a file growing in between came back in full (1205 of
 * 2211 reads past a 1 KiB cap, up to 4.7 MB). The growth is made deterministic
 * here by appending to the file right after the handle's own `stat` returns.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Sandbox } from "../src/sandbox.js";
import { FileTooLargeError, readFile } from "../src/tools.js";

const LIMIT = 1024;
let root: string;
let deps: { sandbox: Sandbox; maxBytes: number; readOnly: boolean };

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "read-bounded-")));
  deps = { sandbox: await Sandbox.create([root]), maxBytes: LIMIT, readOnly: false };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("read_file under a growing file (#232)", () => {
  it("refuses content that grew past the cap after the size check", async () => {
    const file = path.join(root, "log.txt");
    await fs.writeFile(file, "x");
    const probe = await fs.open(file, "r");
    const proto = Object.getPrototypeOf(probe) as { stat: (...a: unknown[]) => Promise<unknown> };
    await probe.close();
    const realStat = proto.stat;
    vi.spyOn(proto, "stat").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const st = await realStat.apply(this, args);
      await fs.appendFile(file, "y".repeat(5 * LIMIT)); // grows after the check
      return st;
    });
    await expect(readFile(deps, file)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("a file exactly at the cap is still read in full", async () => {
    await fs.writeFile(path.join(root, "edge.txt"), "z".repeat(LIMIT));
    expect(await readFile(deps, path.join(root, "edge.txt"))).toBe("z".repeat(LIMIT));
  });

  it("a file over the cap at the check is refused with its size", async () => {
    await fs.writeFile(path.join(root, "big.txt"), "z".repeat(LIMIT + 1));
    await expect(readFile(deps, path.join(root, "big.txt"))).rejects.toThrow(`file size ${LIMIT + 1} > limit ${LIMIT} bytes`);
  });
});
