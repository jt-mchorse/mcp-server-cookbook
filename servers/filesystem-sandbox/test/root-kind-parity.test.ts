// `Sandbox.create` refuses a root that is not a directory, as the Python port
// does (#198). Both ports accepted a regular file -- `fs.realpath` succeeds on
// one -- against the Python `create` docstring ("Each root must exist and be a
// directory"). The rows live in test-fixtures/root_kind_parity.json and the
// Python suite reads the same file.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Sandbox, SandboxEscape } from "../src/sandbox.js";

interface Case {
  label: string;
  root: string;
  expect: "ok" | "escape";
  resolved?: string;
  reason?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(
  await fs.readFile(path.resolve(here, "../../../test-fixtures/root_kind_parity.json"), "utf-8"),
) as {
  tree: { dirs: string[]; files: Record<string, string>; symlinks: { link: string; target: string }[] };
  cases: Case[];
};

let base: string;

async function buildTree(): Promise<void> {
  for (const d of TABLE.tree.dirs) await fs.mkdir(path.join(base, d), { recursive: true });
  for (const [rel, content] of Object.entries(TABLE.tree.files)) {
    await fs.writeFile(path.join(base, rel), content);
  }
  for (const l of TABLE.tree.symlinks) {
    await fs.symlink(path.join(base, l.target), path.join(base, l.link));
  }
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "root-kind-"));
  await buildTree();
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("root kind parity (#198)", () => {
  it("the table covers both refusal reasons and two accepts", () => {
    const reasons = new Set(TABLE.cases.filter((c) => c.expect === "escape").map((c) => c.reason));
    expect([...reasons].sort()).toEqual(["root_does_not_exist", "root_not_a_directory"]);
    expect(TABLE.cases.filter((c) => c.expect === "ok")).toHaveLength(2);
  });

  for (const c of TABLE.cases) {
    it(c.label, async () => {
      const root = path.join(base, c.root);
      if (c.expect === "ok") {
        const sb = await Sandbox.create([root]);
        const expected = (await fs.realpath(path.join(base, c.resolved!))) + path.sep;
        expect(sb.allowedRoots).toEqual([expected]);
      } else {
        const err = await Sandbox.create([root]).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SandboxEscape);
        expect(err).toMatchObject({ reason: c.reason, input: root });
      }
    });
  }

  it("a file root is refused even beside a valid one", async () => {
    await expect(
      Sandbox.create([path.join(base, "dir"), path.join(base, "file.txt")]),
    ).rejects.toMatchObject({ reason: "root_not_a_directory" });
  });
});
