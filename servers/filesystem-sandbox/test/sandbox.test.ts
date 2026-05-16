import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sandbox, SandboxEscape } from "../src/sandbox.js";

/**
 * Path-traversal coverage for the filesystem sandbox.
 *
 * Every test creates a tmpdir, sets up its layout (sometimes including
 * symlinks pointing outside the allow-list), constructs the sandbox
 * with that tmpdir as a root, then exercises the resolution surface.
 */

let allowedRoot: string;
let outsideRoot: string;

beforeEach(async () => {
  allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fs-sandbox-allowed-"));
  outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fs-sandbox-outside-"));
});

afterEach(async () => {
  await fs.rm(allowedRoot, { recursive: true, force: true });
  await fs.rm(outsideRoot, { recursive: true, force: true });
});

async function mkSandbox(): Promise<Sandbox> {
  return Sandbox.create([allowedRoot]);
}

describe("Sandbox construction", () => {
  it("requires at least one allow-list root", async () => {
    await expect(Sandbox.create([])).rejects.toThrow(/at least one allow-list root/);
  });

  it("rejects a root that doesn't exist", async () => {
    await expect(Sandbox.create([path.join(outsideRoot, "nope")])).rejects.toBeInstanceOf(
      SandboxEscape,
    );
  });

  it("resolves roots to their canonical paths", async () => {
    const linked = path.join(outsideRoot, "link-to-allowed");
    await fs.symlink(allowedRoot, linked);
    const sandbox = await Sandbox.create([linked]);
    // The symlink target should be the resolved root, not the symlink path itself.
    const resolved = sandbox.allowedRoots[0]!;
    expect(resolved.startsWith(await fs.realpath(allowedRoot))).toBe(true);
  });
});

// ---------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------

describe("resolve()", () => {
  it("accepts a file inside the allow-list", async () => {
    const file = path.join(allowedRoot, "ok.txt");
    await fs.writeFile(file, "hello");
    const sandbox = await mkSandbox();
    const sp = await sandbox.resolve(file);
    expect(sp.resolved).toBe(await fs.realpath(file));
  });

  it("rejects a path outside the allow-list", async () => {
    const file = path.join(outsideRoot, "secret.txt");
    await fs.writeFile(file, "shh");
    const sandbox = await mkSandbox();
    await expect(sandbox.resolve(file)).rejects.toMatchObject({
      reason: "outside_allowlist",
    });
  });

  it("rejects a path containing `..` traversal that lands outside", async () => {
    const file = path.join(outsideRoot, "secret.txt");
    await fs.writeFile(file, "shh");
    const sandbox = await mkSandbox();
    const traversal = path.join(allowedRoot, "..", path.basename(outsideRoot), "secret.txt");
    await expect(sandbox.resolve(traversal)).rejects.toMatchObject({
      reason: "outside_allowlist",
    });
  });

  it("accepts `..` that stays inside the allow-list", async () => {
    const sub = path.join(allowedRoot, "sub");
    await fs.mkdir(sub);
    const target = path.join(sub, "..", "ok.txt");
    await fs.writeFile(path.join(allowedRoot, "ok.txt"), "hi");
    const sandbox = await mkSandbox();
    const sp = await sandbox.resolve(target);
    expect(sp.resolved).toBe(await fs.realpath(path.join(allowedRoot, "ok.txt")));
  });

  it("rejects a symlink that points outside the allow-list", async () => {
    const target = path.join(outsideRoot, "secret.txt");
    await fs.writeFile(target, "shh");
    const link = path.join(allowedRoot, "leak");
    await fs.symlink(target, link);
    const sandbox = await mkSandbox();
    await expect(sandbox.resolve(link)).rejects.toMatchObject({
      reason: "outside_allowlist",
    });
  });

  it("rejects a relative path", async () => {
    const sandbox = await mkSandbox();
    await expect(sandbox.resolve("relative/path.txt")).rejects.toMatchObject({
      reason: "input_relative_disallowed",
    });
  });

  it("rejects an empty input", async () => {
    const sandbox = await mkSandbox();
    await expect(sandbox.resolve("")).rejects.toMatchObject({ reason: "input_empty" });
  });

  it("rejects a null byte in the input", async () => {
    const sandbox = await mkSandbox();
    const evil = path.join(allowedRoot, "ok.txt") + "\0/etc/passwd";
    await expect(sandbox.resolve(evil)).rejects.toMatchObject({
      reason: "input_null_byte",
    });
  });

  it("rejects an ASCII control character (LF) in the input", async () => {
    const sandbox = await mkSandbox();
    await expect(sandbox.resolve("/path/with\nnewline")).rejects.toMatchObject({
      reason: "input_control_char",
    });
  });

  it("rejects a non-existent path under mustExist=true (default)", async () => {
    const sandbox = await mkSandbox();
    const missing = path.join(allowedRoot, "does-not-exist");
    await expect(sandbox.resolve(missing)).rejects.toMatchObject({
      reason: "outside_allowlist",
    });
  });

  it("accepts a non-existent path under mustExist=false when the parent is inside", async () => {
    const sandbox = await mkSandbox();
    const target = path.join(allowedRoot, "new-file.txt");
    const sp = await sandbox.resolve(target, { mustExist: false });
    expect(sp.resolved).toBe(path.join(await fs.realpath(allowedRoot), "new-file.txt"));
  });

  it("rejects a non-existent path whose parent is outside the allow-list", async () => {
    const sandbox = await mkSandbox();
    const target = path.join(outsideRoot, "new-file.txt");
    await expect(sandbox.resolve(target, { mustExist: false })).rejects.toMatchObject({
      reason: "outside_allowlist",
    });
  });

  it("rejects a non-existent path under a symlinked parent pointing outside", async () => {
    const sandbox = await mkSandbox();
    const evilDir = path.join(allowedRoot, "evil-link");
    await fs.symlink(outsideRoot, evilDir);
    const target = path.join(evilDir, "new-file.txt");
    await expect(sandbox.resolve(target, { mustExist: false })).rejects.toMatchObject({
      reason: "outside_allowlist",
    });
  });
});

// ---------------------------------------------------------------------
// resolveDir() / resolveFile()
// ---------------------------------------------------------------------

describe("resolveDir / resolveFile", () => {
  it("resolveDir accepts a directory; rejects a file", async () => {
    const sub = path.join(allowedRoot, "sub");
    await fs.mkdir(sub);
    const file = path.join(allowedRoot, "ok.txt");
    await fs.writeFile(file, "hi");
    const sandbox = await mkSandbox();
    await expect(sandbox.resolveDir(sub)).resolves.toMatchObject({});
    await expect(sandbox.resolveDir(file)).rejects.toMatchObject({
      reason: "not_a_directory",
    });
  });

  it("resolveFile accepts a regular file; rejects a directory", async () => {
    const sub = path.join(allowedRoot, "sub");
    await fs.mkdir(sub);
    const file = path.join(allowedRoot, "ok.txt");
    await fs.writeFile(file, "hi");
    const sandbox = await mkSandbox();
    await expect(sandbox.resolveFile(file)).resolves.toMatchObject({});
    await expect(sandbox.resolveFile(sub)).rejects.toMatchObject({
      reason: "not_a_file",
    });
  });
});

// ---------------------------------------------------------------------
// Boundary edge cases
// ---------------------------------------------------------------------

describe("boundary edges", () => {
  it("does not match a sibling path that starts with the root's name", async () => {
    // /tmp/foo as root must not accept /tmp/foobar/anything.
    const sibling = `${allowedRoot}bar`;
    await fs.mkdir(sibling);
    try {
      const file = path.join(sibling, "secret.txt");
      await fs.writeFile(file, "shh");
      const sandbox = await mkSandbox();
      await expect(sandbox.resolve(file)).rejects.toMatchObject({
        reason: "outside_allowlist",
      });
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });

  it("accepts the allow-list root itself as a directory", async () => {
    const sandbox = await mkSandbox();
    const sp = await sandbox.resolveDir(allowedRoot);
    expect(sp.resolved).toBe(await fs.realpath(allowedRoot));
  });
});
