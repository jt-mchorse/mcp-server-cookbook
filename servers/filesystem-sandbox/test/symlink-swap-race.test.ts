/**
 * A path component swapped for a symlink AFTER the sandbox check (#233).
 *
 * `Sandbox.resolve` realpath's the input and checks containment; the tools
 * then did their IO by path, and the kernel followed whatever the path named
 * by then. A hunt agent raced it with `renamex_np(RENAME_SWAP)` and measured
 * 5306/39870 reads returning an outside file and 763/966 writes landing
 * outside. These tests make the race deterministic instead: the sandbox below
 * performs the swap the moment `resolve*` returns, which is the worst-case
 * interleaving, and every tool must then refuse without touching the outside
 * directory. The Python port's `tests/test_symlink_swap_race.py` holds the
 * same arms.
 */
import { execFileSync } from "node:child_process";
import { promises as fs, constants as fsc } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Sandbox, SandboxEscape } from "../src/sandbox.js";
import { listDirectory, readFile, writeFile, type ToolDeps } from "../src/tools.js";

let base: string;
let root: string;
let out: string;
let sandbox: Sandbox;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swap-race-")));
  root = path.join(base, "root");
  out = path.join(base, "out");
  await fs.mkdir(path.join(root, "realsub", "deeper"), { recursive: true });
  await fs.mkdir(path.join(out, "deeper"), { recursive: true });
  await fs.writeFile(path.join(root, "realsub", "f.txt"), "inside");
  await fs.writeFile(path.join(root, "realsub", "deeper", "f.txt"), "inside");
  await fs.writeFile(path.join(out, "f.txt"), "SECRET-OUTSIDE");
  await fs.writeFile(path.join(out, "deeper", "f.txt"), "SECRET-OUTSIDE");
  sandbox = await Sandbox.create([root]);
});

afterEach(async () => {
  await fs.chmod(path.join(root, "realsub"), 0o755).catch(() => undefined);
  await fs.rm(base, { recursive: true, force: true });
});

/** Replace `<root>/<rel>` with a symlink to `target`, as a racing writer would. */
async function swapForSymlink(rel: string, target: string): Promise<void> {
  await fs.rename(path.join(root, rel), path.join(root, `${rel}.moved`));
  await fs.symlink(target, path.join(root, rel));
}

/** A sandbox whose every `resolve*` runs `after` before returning. */
function racing(after: () => Promise<void>): Sandbox {
  return new Proxy(sandbox, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        await after();
        return result;
      };
    },
  });
}

function deps(s: Sandbox): ToolDeps {
  return { sandbox: s, readOnly: false, maxBytes: 1_000_000 };
}

async function outsideSnapshot(): Promise<string> {
  const names = (await fs.readdir(out)).sort();
  return JSON.stringify([names, await fs.readFile(path.join(out, "f.txt"), "utf8")]);
}

async function refusal(p: Promise<unknown>): Promise<SandboxEscape> {
  const err = await p.then(
    (v) => new Error(`expected a refusal, got ${JSON.stringify(v)}`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SandboxEscape);
  return err as SandboxEscape;
}

describe("a parent directory swapped for a symlink after the check (#233)", () => {
  const swapParent = () => swapForSymlink("realsub", out);

  it("read_file refuses instead of returning the outside file", async () => {
    const err = await refusal(readFile(deps(racing(swapParent)), path.join(root, "realsub", "f.txt")));
    expect(err.reason).toBe("outside_allowlist");
  });

  it("list_directory refuses instead of listing (and sizing) the outside directory", async () => {
    const err = await refusal(listDirectory(deps(racing(swapParent)), path.join(root, "realsub")));
    expect(err.reason).toBe("outside_allowlist");
  });

  it("write_file over an existing name refuses and leaves the outside directory untouched", async () => {
    const before = await outsideSnapshot();
    const err = await refusal(writeFile(deps(racing(swapParent)), path.join(root, "realsub", "f.txt"), "PWNED"));
    expect(err.reason).toBe("outside_allowlist");
    expect(await outsideSnapshot()).toBe(before);
  });

  it("write_file of a new name refuses and creates nothing outside (no temp file either)", async () => {
    const before = await outsideSnapshot();
    const err = await refusal(writeFile(deps(racing(swapParent)), path.join(root, "realsub", "new.txt"), "PWNED"));
    expect(err.reason).toBe("outside_allowlist");
    expect(await outsideSnapshot()).toBe(before);
  });

  it("a swap two levels up is refused too: every component is checked, not only the parent", async () => {
    const err = await refusal(
      readFile(deps(racing(swapParent)), path.join(root, "realsub", "deeper", "f.txt")),
    );
    expect(err.reason).toBe("outside_allowlist");
  });
});

describe("the leaf swapped after the check (#233)", () => {
  it("read_file refuses a leaf swapped for a symlink to an outside file", async () => {
    const swap = () => swapForSymlink(path.join("realsub", "f.txt"), path.join(out, "f.txt"));
    const err = await refusal(readFile(deps(racing(swap)), path.join(root, "realsub", "f.txt")));
    expect(err.reason).toBe("outside_allowlist");
  });

  it("write_file replaces a leaf swapped for a symlink rather than writing through it", async () => {
    const before = await outsideSnapshot();
    const swap = () => swapForSymlink(path.join("realsub", "f.txt"), path.join(out, "f.txt"));
    await writeFile(deps(racing(swap)), path.join(root, "realsub", "f.txt"), "new");
    expect(await outsideSnapshot()).toBe(before);
    const leaf = path.join(root, "realsub", "f.txt");
    expect((await fs.lstat(leaf)).isFile()).toBe(true);
    expect(await fs.readFile(leaf, "utf8")).toBe("new");
  });

  it.skipIf(process.platform === "win32")(
    "read_file refuses a leaf swapped for a FIFO without blocking on the open",
    async () => {
      const leaf = path.join(root, "realsub", "f.txt");
      const swap = async () => {
        await fs.unlink(leaf);
        execFileSync("mkfifo", [leaf]);
      };
      // Watchdog: a reader blocked in `open` is released by a writer opening
      // the FIFO, so an unfixed read fails this arm instead of hanging the run.
      const watchdog = setTimeout(() => {
        fs.open(leaf, fsc.O_WRONLY | fsc.O_NONBLOCK)
          .then((fh) => fh.close())
          .catch(() => undefined);
      }, 2000);
      try {
        const err = await refusal(readFile(deps(racing(swap)), leaf));
        expect(err.reason).toBe("not_a_file");
      } finally {
        clearTimeout(watchdog);
      }
    },
    10_000,
  );
});

describe("controls: nothing the check accepts is refused when the tree holds still", () => {
  it("read, list and write work under a symlinked allow-list root", async () => {
    const link = path.join(base, "root-link");
    await fs.symlink(root, link);
    const d = deps(await Sandbox.create([link]));
    await writeFile(d, path.join(link, "realsub", "g.txt"), "via link");
    expect(await readFile(d, path.join(link, "realsub", "g.txt"))).toBe("via link");
    const names = (await listDirectory(d, path.join(link, "realsub"))).map((e) => e.name);
    expect(names).toEqual(["deeper", "f.txt", "g.txt"]);
  });

  it("write_file through an in-root symlinked leaf still writes its in-root target", async () => {
    await fs.symlink(path.join(root, "realsub", "f.txt"), path.join(root, "alias.txt"));
    await writeFile(deps(sandbox), path.join(root, "alias.txt"), "via alias");
    expect(await fs.readFile(path.join(root, "realsub", "f.txt"), "utf8")).toBe("via alias");
  });

  it("read_file through an in-root symlinked directory reads the real file", async () => {
    await fs.symlink(path.join(root, "realsub"), path.join(root, "alias"));
    expect(await readFile(deps(sandbox), path.join(root, "alias", "f.txt"))).toBe("inside");
  });

  // Root ignores permission bits, so the arm would prove nothing as root.
  it.skipIf(process.getuid?.() === 0)(
    "a search-only (0311) directory on the way still reads and writes, as a path lookup did",
    async () => {
      await fs.chmod(path.join(root, "realsub"), 0o311);
      const d = deps(sandbox);
      expect(await readFile(d, path.join(root, "realsub", "deeper", "f.txt"))).toBe("inside");
      await writeFile(d, path.join(root, "realsub", "new.txt"), "x");
      await fs.chmod(path.join(root, "realsub"), 0o755);
      expect(await fs.readFile(path.join(root, "realsub", "new.txt"), "utf8")).toBe("x");
    },
  );
});
