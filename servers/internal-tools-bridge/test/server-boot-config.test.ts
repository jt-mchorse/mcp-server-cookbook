/**
 * The server refuses to start with an unusable `MCP_BRIDGE_CWD` (#145).
 *
 * `validateConfig` used to be called only from `runBridged`, i.e. at the first
 * tool call. So a server started with a bad `MCP_BRIDGE_CWD` booted,
 * completed the MCP handshake, and **advertised `repo_stats` in `tools/list`**
 * — then failed the call with `BridgeConfig.cwd must be an absolute path`. To
 * a client that reads as a runtime failure rather than a configuration one,
 * and an agent has already chosen the tool by then.
 *
 * Measured over a real stdio session before the fix:
 *
 *     MCP_BRIDGE_CWD=''          boot: STILL RUNNING, tools/list ADVERTISED repo_stats
 *     MCP_BRIDGE_CWD='./rel'     boot: STILL RUNNING, tools/list ADVERTISED repo_stats
 *     github-gists, bad timeout  boot: EXITED code=1, no tools/list response
 *
 * These tests **spawn a real server** rather than calling `validateConfig` in
 * process, because the defect is about *when the process is willing to serve*.
 * The bridge's existing 55-test suite passed with the bug in place precisely
 * because nothing observed the boundary between "booted" and "serving" — an
 * in-process unit test structurally cannot see it.
 *
 * `tsx` is used rather than `dist/`: CI runs `npm test` *before*
 * `npm run build`, so a test that spawned the compiled output would either
 * fail on a clean checkout or silently test a stale build.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "..", "src", "server.ts");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

interface BootResult {
  readonly exited: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function rpc(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

/**
 * Spawn the server, drive `initialize` + `tools/list`, and report whether it
 * was still willing to serve.
 */
async function boot(env: Record<string, string>): Promise<BootResult> {
  return await new Promise<BootResult>((resolvePromise) => {
    const child = spawn(process.execPath, [TSX_CLI, SERVER], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exited: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolvePromise({ exited, code, stdout, stderr });
    };

    child.stdout.on("data", (d) => {
      stdout += String(d);
      // Resolve as soon as the server has answered `tools/list`. Waiting a
      // fixed interval instead would add seconds per case to a suite that runs
      // this eight times.
      if (stdout.includes("repo_stats")) finish(false, null);
    });
    child.stderr.on("data", (d) => (stderr += String(d)));

    child.on("exit", (code) => finish(true, code));

    // Written immediately: stdin is buffered, so the server reads these once
    // it is up. A fixed pre-write delay would only be guessing at tsx's start
    // time, which is exactly the kind of host-timing assumption that makes a
    // test flaky on a slower CI box.
    child.stdin.write(
      rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "boot-test", version: "0" },
      }),
    );
    child.stdin.write(rpc(2, "tools/list", {}));

    // The upper bound only has to be generous enough that a slow box does not
    // report "still running" as a timeout; the happy path never reaches it,
    // and the failing path exits on its own.
    const cap = setTimeout(() => finish(false, null), 15_000);
  });
}

const TIMEOUT = 30_000;

describe("an unusable MCP_BRIDGE_CWD stops the server before it serves", () => {
  it.each([["./relative"], ["relative/path"], ["~/tilde-not-expanded"], ["."]])(
    "%j exits at boot and never advertises repo_stats",
    async (value) => {
      const result = await boot({ MCP_BRIDGE_CWD: value });
      expect(result.exited, `server kept running with MCP_BRIDGE_CWD=${value}`).toBe(true);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("repo_stats");
    },
    TIMEOUT,
  );

  it(
    "names the environment variable, not just the config field",
    async () => {
      // The operator set MCP_BRIDGE_CWD. `BridgeConfig.cwd` is an
      // implementation detail they never typed.
      const result = await boot({ MCP_BRIDGE_CWD: "./relative" });
      expect(result.stderr).toContain("MCP_BRIDGE_CWD");
      expect(result.stderr).toContain("refusing to start");
      expect(result.stderr).toContain("absolute path");
    },
    TIMEOUT,
  );

  it(
    "quotes the offending value so a quoting mistake is visible",
    async () => {
      const result = await boot({ MCP_BRIDGE_CWD: "  ./relative  " });
      expect(result.stderr).toMatch(/MCP_BRIDGE_CWD=/);
    },
    TIMEOUT,
  );
});

describe("a usable MCP_BRIDGE_CWD still serves", () => {
  it(
    "unset falls back to the process working directory",
    async () => {
      const result = await boot({});
      expect(result.exited, result.stderr).toBe(false);
      expect(result.stdout).toContain("repo_stats");
    },
    TIMEOUT,
  );

  it.each([[""], ["   "], ["\t"]])(
    "set-but-empty (%j) is treated as unset, not as an empty path",
    async (value) => {
      // `??` fires on null/undefined only, so this used to reach
      // `defaultBridgeConfig` as "" and boot a server that advertised a tool
      // it could not run.
      const result = await boot({ MCP_BRIDGE_CWD: value });
      expect(result.exited, result.stderr).toBe(false);
      expect(result.stdout).toContain("repo_stats");
    },
    TIMEOUT,
  );

  it(
    "an absolute path is honoured and echoed in the startup log",
    async () => {
      const abs = resolve(__dirname, "..");
      const result = await boot({ MCP_BRIDGE_CWD: abs });
      expect(result.exited, result.stderr).toBe(false);
      expect(result.stdout).toContain("repo_stats");
      expect(result.stderr).toContain(`cwd=${abs}`);
    },
    TIMEOUT,
  );

  it(
    "the startup log never renders an empty cwd as if it were a value",
    async () => {
      // Before the fix this printed `cwd= node=/...`, displaying the broken
      // value indistinguishably from a good one — part of why it survived.
      const result = await boot({ MCP_BRIDGE_CWD: "" });
      expect(result.stderr).not.toMatch(/cwd=\s+node=/);
      expect(result.stderr).toMatch(/cwd=\S+/);
    },
    TIMEOUT,
  );
});
