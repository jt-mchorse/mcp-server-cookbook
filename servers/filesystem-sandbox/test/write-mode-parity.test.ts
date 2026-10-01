/**
 * File-mode parity for the atomic write, shared with the Python port (#200).
 *
 * `atomicWriteFile` used to create its temp file with
 * `fs.open(tmp, O_WRONLY|O_CREAT|O_EXCL, 0o600)`, and `fs.rename` carried that
 * mode onto the target. So every file `write_file` created was owner-only
 * regardless of umask, and an overwrite demoted an existing 0644 file to 0600
 * — while the plain `fs.writeFile` it replaced honoured the umask and kept the
 * existing mode. The Python port had the same defect (`NamedTemporaryFile`).
 *
 * The table lives in `test-fixtures/write_mode_parity.json` and is read by
 * BOTH suites. Every row runs twice: against `atomicWriteFile` directly and
 * through the real `writeFile` tool, so a call site that stops routing through
 * the helper is caught as well. The process umask is set per row and restored
 * in `finally` (vitest's default `forks` pool runs each file in a child
 * process, where `process.umask(mask)` is allowed).
 */

import { readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../src/atomic_write.js";
import { Sandbox } from "../src/sandbox.js";
import { writeFile } from "../src/tools.js";

interface ModeCase {
  label: string;
  umask: string;
  preexisting_mode: string | null;
  expected_mode: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = path.join(HERE, "..", "..", "..", "test-fixtures", "write_mode_parity.json");
const table = JSON.parse(readFileSync(TABLE_PATH, "utf8")) as { cases: ModeCase[] };

const ROUTES: Record<string, (root: string, target: string) => Promise<void>> = {
  helper: async (_root, target) => {
    await atomicWriteFile(target, Buffer.from("new content"));
  },
  write_file: async (root, target) => {
    const deps = { sandbox: await Sandbox.create([root]), readOnly: false, maxBytes: 1024 };
    await writeFile(deps, target, "new content");
  },
};

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fs-mode-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("write_file mode parity (#200)", () => {
  it("the shared table is present and non-trivial", () => {
    // A silently empty parity suite is worse than none.
    expect(table.cases.length).toBeGreaterThanOrEqual(5);
    expect(table.cases.some((c) => c.preexisting_mode === null)).toBe(true);
    expect(table.cases.some((c) => c.preexisting_mode !== null)).toBe(true);
  });

  for (const c of table.cases) {
    for (const route of Object.keys(ROUTES).sort()) {
      it(`${c.label} [${route}]`, async () => {
        const target = path.join(root, "out.txt");
        if (c.preexisting_mode !== null) {
          await fs.writeFile(target, "old content");
          await fs.chmod(target, parseInt(c.preexisting_mode, 8));
          // Control: the precondition really holds.
          expect((await fs.stat(target)).mode & 0o7777).toBe(parseInt(c.preexisting_mode, 8));
        }

        const old = process.umask(parseInt(c.umask, 8));
        try {
          await ROUTES[route]!(root, target);
        } finally {
          process.umask(old);
        }

        expect(await fs.readFile(target, "utf8")).toBe("new content");
        const got = (await fs.stat(target)).mode & 0o7777;
        expect(got.toString(8), `${c.label} via ${route}`).toBe(c.expected_mode);
        // No temp sibling left behind.
        expect(await fs.readdir(root)).toEqual(["out.txt"]);
      });
    }
  }
});
