import { promises as fs, existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox, SandboxEscape } from "../src/sandbox.js";

/**
 * Case- and normalization-aliased paths on a case-insensitive darwin volume
 * (#298), the TS half of `filesystem-sandbox-py/tests/test_sandbox_case_fold.py`.
 *
 * `fs.realpath` is libc `realpath(3)`, which returns each component's ON-DISK
 * name. The Python port used to keep the case as typed and refused
 * `root/f.txt` under a `Root/` root; it now calls the same libc function. This
 * file pins the TS side of that contract so the two cannot drift apart again
 * without a red test on a Mac. CI's ubuntu volume is case-sensitive, so the
 * aliases do not exist there and the cases skip.
 */

const NFD_NAME = "é.txt".normalize("NFD");
const NFC_NAME = "é.txt".normalize("NFC");

const tmp = realpathSync(os.tmpdir());
// Decided in `beforeAll`: the fixture's `Root` is reachable as `root`.
let caseInsensitive = false;
let base: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(tmp, "mcp-fs-case-"));
  const root = path.join(base, "Root");
  await fs.mkdir(path.join(root, "Sub"), { recursive: true });
  await fs.writeFile(path.join(root, "f.txt"), "f");
  await fs.link(path.join(root, "f.txt"), path.join(root, "g.txt"));
  await fs.writeFile(path.join(root, NFD_NAME), "e");
  await fs.symlink("F.TXT", path.join(root, "flink"));
  await fs.mkdir(path.join(base, "Other"));
  await fs.writeFile(path.join(base, "Other", "secret.txt"), "s");
  await fs.mkdir(path.join(base, "RootX"));
  await fs.writeFile(path.join(base, "RootX", "f.txt"), "x");
  caseInsensitive = process.platform === "darwin" && existsSync(path.join(base, "root"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const p = (rel: string): string => base + path.sep + rel;

// [label, root as typed, input, mustExist, expected resolved path]
const accepted: Array<[string, string, string, boolean, string]> = [
  ["a case alias of the root", "Root", "root/f.txt", true, "Root/f.txt"],
  ["a case alias of the leaf", "Root", "Root/F.TXT", true, "Root/f.txt"],
  ["a root spelled in another case", "root", "Root/f.txt", true, "Root/f.txt"],
  ["a hardlink alias keeps its own name", "Root", "Root/G.TXT", true, "Root/g.txt"],
  ["a normalization alias", "Root", `ROOT/${NFC_NAME}`, true, `Root/${NFD_NAME}`],
  ["a write under a case-aliased parent", "Root", "root/sub/new.txt", false, "Root/Sub/new.txt"],
  ["a write through a leaf symlink", "Root", "Root/flink", false, "Root/f.txt"],
  ["a write leaf keeps the case it was given", "Root", "Root/F.TXT", false, "Root/F.TXT"],
  ["exact case is unchanged", "Root", "Root/f.txt", true, "Root/f.txt"],
];

describe("case-aliased paths on a case-insensitive darwin volume (#298)", () => {
  for (const [label, rootArg, input, mustExist, expected] of accepted) {
    it(label, async (ctx) => {
      if (!caseInsensitive) ctx.skip();
      const sb = await Sandbox.create([p(rootArg)]);
      expect(sb.allowedRoots).toEqual([p("Root/")]);
      const sp = await sb.resolve(p(input), { mustExist });
      expect(sp.resolved).toBe(p(expected));
    });
  }

  for (const rel of ["other/secret.txt", "OTHER/secret.txt", "rootx/f.txt", "ROOTX/f.txt"]) {
    it(`a case alias outside the root is still refused: ${rel}`, async (ctx) => {
      if (!caseInsensitive) ctx.skip();
      const sb = await Sandbox.create([p("Root")]);
      const err = await sb.resolve(p(rel)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SandboxEscape);
      expect((err as SandboxEscape).reason).toBe("outside_allowlist");
    });
  }
});
