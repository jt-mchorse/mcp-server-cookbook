// Content and listing parity with the Python port (#209). Rows live in
// test-fixtures/content_parity.json; the Python suite reads the same file.
//
// Measured on main before #209: `write_file` wrote U+FFFD for a lone surrogate
// and reported success; `read_file` stripped a leading BOM; `list_directory`
// ordered by `localeCompare`, so the order depended on the host locale.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Sandbox } from "../src/sandbox.js";
import { compareCodePoints, errorMessage, listDirectory, readFile, writeFile } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(
  await fs.readFile(path.resolve(here, "../../../test-fixtures/content_parity.json"), "utf-8"),
) as {
  write_cases: { label: string; content: string; error?: string; bytes_written?: number }[];
  read_cases: { label: string; bytes_hex: string; text: string }[];
  list_names: string[];
  list_order: string[];
};

let root: string;
let deps: { sandbox: Sandbox; maxBytes: number; readOnly: boolean };

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "content-parity-")));
  deps = { sandbox: await Sandbox.create([root]), maxBytes: 1 << 20, readOnly: false };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("write_file (#209)", () => {
  for (const c of TABLE.write_cases) {
    it(c.label, async () => {
      const file = path.join(root, "out.txt");
      if (c.error !== undefined) {
        const err = await writeFile(deps, file, c.content).catch((e: unknown) => e);
        expect(errorMessage(err)).toBe(c.error);
        await expect(fs.stat(file)).rejects.toThrow(); // nothing written
      } else {
        expect(await writeFile(deps, file, c.content)).toEqual({ bytes_written: c.bytes_written });
        expect(await fs.readFile(file, "utf-8")).toBe(c.content);
      }
    });
  }
});

describe("read_file (#209)", () => {
  for (const c of TABLE.read_cases) {
    it(c.label, async () => {
      const file = path.join(root, "in.txt");
      await fs.writeFile(file, Buffer.from(c.bytes_hex, "hex"));
      expect(await readFile(deps, file)).toBe(c.text);
    });
  }
});

describe("list_directory (#209)", () => {
  it("orders entries by code point, as Python's sorted does", async () => {
    for (const name of TABLE.list_names) await fs.writeFile(path.join(root, name), "");
    const names = (await listDirectory(deps, root)).map((e) => e.name);
    expect(names).toEqual(TABLE.list_order);
  });

  it("compareCodePoints puts an astral character after U+E000 (where `<` would not)", () => {
    expect(compareCodePoints("\u{1F600}", "")).toBeGreaterThan(0);
    expect("\u{1F600}" < "").toBe(true);
    expect(compareCodePoints("ab", "a")).toBeGreaterThan(0);
    expect(compareCodePoints("a", "a")).toBe(0);
  });
});
