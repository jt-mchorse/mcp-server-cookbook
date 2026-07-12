import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sandbox } from "../src/sandbox.js";
import {
  FileTooLargeError,
  WriteForbiddenError,
  listDirectory,
  readFile,
  writeFile,
} from "../src/tools.js";

let allowedRoot: string;

beforeEach(async () => {
  allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fs-tools-"));
});

afterEach(async () => {
  await fs.rm(allowedRoot, { recursive: true, force: true });
});

async function deps(opts: { readOnly?: boolean; maxBytes?: number } = {}) {
  const sandbox = await Sandbox.create([allowedRoot]);
  return {
    sandbox,
    readOnly: opts.readOnly ?? false,
    maxBytes: opts.maxBytes ?? 1_000_000,
  };
}

describe("listDirectory", () => {
  it("lists entries by name with kind", async () => {
    await fs.writeFile(path.join(allowedRoot, "a.txt"), "a");
    await fs.mkdir(path.join(allowedRoot, "sub"));
    await fs.writeFile(path.join(allowedRoot, "b.txt"), "bb");
    const entries = await listDirectory(await deps(), allowedRoot);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "sub"]);
    expect(entries[0]).toMatchObject({ name: "a.txt", kind: "file", size: 1 });
    expect(entries[2]).toMatchObject({ name: "sub", kind: "directory" });
  });

  it("refuses paths outside the allow-list", async () => {
    await expect(listDirectory(await deps(), "/etc")).rejects.toThrow(/outside_allowlist/);
  });
});

describe("readFile", () => {
  it("reads a UTF-8 text file", async () => {
    const file = path.join(allowedRoot, "x.txt");
    await fs.writeFile(file, "hello", "utf-8");
    expect(await readFile(await deps(), file)).toBe("hello");
  });

  it("rejects files larger than maxBytes", async () => {
    const file = path.join(allowedRoot, "big.txt");
    await fs.writeFile(file, "0".repeat(2000));
    await expect(readFile(await deps({ maxBytes: 1000 }), file)).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
  });

  it("rejects non-UTF-8 content with a clear error", async () => {
    const file = path.join(allowedRoot, "binary.bin");
    await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(readFile(await deps(), file)).rejects.toThrow(/not valid UTF-8/);
  });

  it("rejects a path that's a directory, not a file", async () => {
    await expect(readFile(await deps(), allowedRoot)).rejects.toThrow(/not_a_file/);
  });
});

describe("writeFile", () => {
  it("writes UTF-8 text", async () => {
    const file = path.join(allowedRoot, "new.txt");
    const r = await writeFile(await deps(), file, "hello world");
    expect(r.bytes_written).toBe(11);
    expect(await fs.readFile(file, "utf-8")).toBe("hello world");
  });

  it("refuses when read-only", async () => {
    const file = path.join(allowedRoot, "new.txt");
    await expect(
      writeFile(await deps({ readOnly: true }), file, "x"),
    ).rejects.toBeInstanceOf(WriteForbiddenError);
  });

  it("rejects content exceeding maxBytes", async () => {
    const file = path.join(allowedRoot, "new.txt");
    await expect(
      writeFile(await deps({ maxBytes: 4 }), file, "12345"),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("rejects a present-but-non-string content with a clean error, not a raw TypeError, and writes nothing (#119)", async () => {
    // The handler casts `a.content as string` with no runtime validation and the
    // SDK doesn't enforce inputSchema types, so a client can send a non-string.
    // A number/object/bool hit `Buffer.from(x)` -> raw TypeError; an ARRAY like
    // [1,2,3] silently wrote raw bytes and reported success. The `path` sibling is
    // typeof-guarded (sandbox _validateInput) — content must match.
    const file = path.join(allowedRoot, "nonstring.txt");
    for (const bad of [123, { a: 1 }, true, [1, 2, 3]]) {
      const err = await writeFile(await deps(), file, bad as unknown as string).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("content must be a string");
      expect(err.message).not.toMatch(/must be of type string|is not a function/);
    }
    // The array case must NOT have created/written the file.
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("refuses to write outside the allow-list", async () => {
    const outside = path.join("/tmp", "definitely-outside-" + Math.random().toString(36).slice(2), "x");
    await expect(writeFile(await deps(), outside, "x")).rejects.toThrow(/outside_allowlist/);
  });

  it("refuses to write through an in-allow-list leaf symlink pointing outside (#60)", async () => {
    // The leaf symlink must be rejected, not silently followed/clobbered.
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fs-tools-outside-"));
    try {
      const victim = path.join(outsideDir, "victim.txt");
      await fs.writeFile(victim, "secret");
      const link = path.join(allowedRoot, "note.txt");
      await fs.symlink(victim, link);

      await expect(writeFile(await deps(), link, "OVERWRITE")).rejects.toThrow(/outside_allowlist/);

      // The symlink must be untouched and the victim's contents intact.
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(victim, "utf-8")).toBe("secret");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
