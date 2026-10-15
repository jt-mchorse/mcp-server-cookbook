/**
 * The read cap is an upper bound, not an allocation (#279).
 *
 * Since #232, `readFile` read into ONE buffer of `maxBytes + 1` with one
 * `read()` of that length, whatever the file's size. `MCP_FS_SANDBOX_MAX_BYTES`
 * is accepted up to `Number.MAX_SAFE_INTEGER` (the #137 parity contract,
 * `test-fixtures/max_bytes_parity.json`), but a `read()` length must fit an
 * int32. Measured on Node 25.5 reading a 5-byte file: cap 2147483646 read it;
 * 2147483647 and 4294967296 aborted the process
 * (`Assertion failed: args[3]->IsInt32()`, exit 134); MAX_SAFE_INTEGER failed
 * with `RangeError ... "size"`. Node 20 failed every read at all three.
 *
 * The read is now chunked at READ_CHUNK_BYTES. The multi-chunk arms pin that
 * the cap still holds exactly across chunk boundaries.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Sandbox } from "../src/sandbox.js";
import { FileTooLargeError, READ_CHUNK_BYTES, readFile } from "../src/tools.js";

let root: string;
let sandbox: Sandbox;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "read-large-cap-")));
  sandbox = await Sandbox.create([root]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const deps = (maxBytes: number) => ({ sandbox, maxBytes, readOnly: true });

describe("a small file reads under any cap the config accepts (#279)", () => {
  it.each([
    ["2**31 - 2 (the largest that read before)", 2 ** 31 - 2],
    ["2**31 - 1 (aborted the process)", 2 ** 31 - 1],
    ["2**32 (aborted the process)", 2 ** 32],
    ["MAX_SAFE_INTEGER (the top of the accepted range)", Number.MAX_SAFE_INTEGER],
  ])("cap %s", async (_name, cap) => {
    await fs.writeFile(path.join(root, "a.txt"), "hello");
    expect(await readFile(deps(cap), path.join(root, "a.txt"))).toBe("hello");
  });
});

describe("the cap holds exactly across chunk boundaries (#279)", () => {
  const cap = 2 * READ_CHUNK_BYTES + 7;

  it("a file spanning several chunks comes back intact", async () => {
    // Not a repeated byte, so a chunk read at the wrong offset changes it.
    const body = Array.from({ length: cap }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    await fs.writeFile(path.join(root, "multi.txt"), body);
    expect(await readFile(deps(cap), path.join(root, "multi.txt"))).toBe(body);
  });

  it("one byte over a multi-chunk cap is refused", async () => {
    await fs.writeFile(path.join(root, "over.txt"), "z".repeat(cap + 1));
    await expect(readFile(deps(cap), path.join(root, "over.txt"))).rejects.toBeInstanceOf(FileTooLargeError);
  });
});
