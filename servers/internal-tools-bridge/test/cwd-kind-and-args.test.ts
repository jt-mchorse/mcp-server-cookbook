/**
 * MCP_BRIDGE_CWD must be an existing directory, and args must be an array (#212).
 *
 * #145 moved `validateBridgeConfig` to boot, but its cwd rule checked only that
 * the path was absolute. Measured on main: a regular file booted, advertised
 * `repo_stats`, and the call returned `spawn ENOTDIR`; a missing directory
 * failed the call as `spawn ... node ENOENT`, blaming the binary. And
 * `runBridged(cfg, node, "-v")` ran node with argv ["-", "v"].
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BridgeError, runBridged, validateBridgeConfig } from "../src/bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "..", "src", "server.ts");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

const scratch = mkdtempSync(join(tmpdir(), "bridge-cwd-"));
const A_FILE = join(scratch, "afile");
writeFileSync(A_FILE, "");
const MISSING = join(scratch, "no", "such", "dir");

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

function boot(cwd: string): Promise<{ exited: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [TSX_CLI, SERVER], {
      env: { ...process.env, MCP_BRIDGE_CWD: cwd },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exited: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      child.kill();
      done({ exited, code, stdout, stderr });
    };
    child.stdout.on("data", (d) => {
      stdout += String(d);
      if (stdout.includes("repo_stats")) finish(false, null);
    });
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("exit", (code) => finish(true, code));
    child.stdin.write(rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    child.stdin.write(rpc(2, "tools/list", {}));
    const cap = setTimeout(() => finish(false, null), 15_000);
  });
}

describe("MCP_BRIDGE_CWD is an existing directory (#212)", () => {
  it.each([
    [A_FILE, "is not a directory"],
    [MISSING, "does not exist"],
  ])("%s exits at boot with %j and never advertises repo_stats", async (cwd, why) => {
    const r = await boot(cwd);
    expect(r.exited, "server kept running").toBe(true);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("repo_stats");
    expect(r.stderr).toContain("MCP_BRIDGE_CWD");
    expect(r.stderr).toContain(why);
  }, 30_000);

  it("a real directory still boots and advertises repo_stats (control)", async () => {
    const r = await boot(scratch);
    expect(r.exited).toBe(false);
    expect(r.stdout).toContain("repo_stats");
  }, 30_000);

  it("validateBridgeConfig refuses both shapes for a programmatic caller too", () => {
    for (const cwd of [A_FILE, MISSING]) {
      expect(() => validateBridgeConfig({ cwd, allowlist: [process.execPath] })).toThrow(BridgeError);
    }
  });
});

describe("runBridged args must be an array (#212)", () => {
  it("a bare string is refused instead of becoming one argv entry per character", async () => {
    await expect(
      runBridged({ cwd: scratch, allowlist: [process.execPath] }, process.execPath, "-v" as unknown as string[]),
    ).rejects.toThrow(/args must be an array of strings/);
  });

  it("an array still runs (control)", async () => {
    const r = await runBridged({ cwd: scratch, allowlist: [process.execPath] }, process.execPath, ["-v"]);
    expect(r.stdout.trim()).toBe(process.version);
  });
});
