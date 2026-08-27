/**
 * A bad `MCP_GITHUB_GISTS_*` value prints one actionable line, not a stack (#146).
 *
 * Split out of `#145`, which fixed *when* `internal-tools-bridge` validates its
 * environment. This server already failed at the right time — `server.ts` calls
 * `readGistsConfigFromEnv()` at module scope, before any transport is attached.
 * The gap was the diagnostic. Uncaught, a module-scope throw prints a Node
 * unhandled-throw block. Measured before this change, with
 * `MCP_GITHUB_GISTS_TIMEOUT_MS=abc`:
 *
 *     file:///.../servers/github-gists/dist/config.js:43
 *                 throw new Error(`MCP_GITHUB_GISTS_TIMEOUT_MS must be a ...
 *                       ^
 *     Error: MCP_GITHUB_GISTS_TIMEOUT_MS must be a positive integer; got "abc"
 *         at readGistsConfigFromEnv (file:///.../dist/config.js:43:19)
 *
 * The *message* was already good — `#143` made it name the variable and the
 * bound — and it is kept verbatim. What changed is the framing: a `dist/`
 * file path and a code frame are noise to someone who mistyped an environment
 * variable, and an MCP client may surface only the first line or two of stderr.
 *
 * These tests **spawn the real process**. The existing 103 gists tests all call
 * the config functions in process, so not one of them can observe what a
 * module-scope throw prints — the same structural blind spot `#145` recorded
 * for the bridge.
 *
 * `tsx` rather than `dist/`: CI runs `npm test` *before* `npm run build`, so a
 * test spawning the compiled output would fail on a clean checkout or silently
 * test a stale build.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      // Resolve as soon as the server has answered `tools/list`, rather than
      // waiting a fixed interval — that would add seconds per case.
      if (stdout.includes("get_gist")) finish(false, null);
    });
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("exit", (code) => finish(true, code));

    child.stdin.write(
      rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "boot-test", version: "0" },
      }),
    );
    child.stdin.write(rpc(2, "tools/list", {}));

    const cap = setTimeout(() => finish(false, null), 15_000);
  });
}

const TIMEOUT = 30_000;

// (label, env) — every one of these is rejected by `readGistsConfigFromEnv`.
const BAD_ENVS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["non-numeric timeout", { MCP_GITHUB_GISTS_TIMEOUT_MS: "abc" }],
  ["negative timeout", { MCP_GITHUB_GISTS_TIMEOUT_MS: "-5" }],
  ["zero timeout", { MCP_GITHUB_GISTS_TIMEOUT_MS: "0" }],
  ["timeout past the setTimeout clamp", { MCP_GITHUB_GISTS_TIMEOUT_MS: "99999999999" }],
  ["non-http base url", { MCP_GITHUB_GISTS_BASE_URL: "ftp://example.com" }],
];

describe("a bad MCP_GITHUB_GISTS_* value refuses the boot with one line", () => {
  it.each(BAD_ENVS)(
    "%s: exits 1 and never advertises get_gist",
    async (_label, env) => {
      const result = await boot(env);
      expect(result.exited, "server kept running with a rejected config").toBe(true);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("get_gist");
    },
    TIMEOUT,
  );

  it.each(BAD_ENVS)(
    "%s: stderr is one actionable line, not a stack trace",
    async (_label, env) => {
      const result = await boot(env);
      const lines = result.stderr.trim().split("\n").filter(Boolean);
      expect(lines, result.stderr).toHaveLength(1);
      expect(lines[0]).toMatch(/^github-gists: refusing to start\./);
      // The three things a stack trace brings and an operator does not need.
      expect(result.stderr).not.toContain("    at ");
      expect(result.stderr).not.toContain("file:///");
      expect(result.stderr).not.toMatch(/^\s*\^\s*$/m);
    },
    TIMEOUT,
  );

  it.each(BAD_ENVS)(
    "%s: names the environment variable the operator actually typed",
    async (_label, env) => {
      const result = await boot(env);
      const variable = Object.keys(env)[0] as string;
      expect(result.stderr).toContain(variable);
      // And the value they set, so a typo is visible without re-reading the shell.
      expect(result.stderr).toContain(JSON.stringify(Object.values(env)[0]));
    },
    TIMEOUT,
  );

  it(
    "keeps the message #143 wrote, verbatim",
    async () => {
      // The framing changed; the diagnosis did not. This is the sentence that
      // explains *why* a huge timeout is rejected, and it must survive.
      const result = await boot({ MCP_GITHUB_GISTS_TIMEOUT_MS: "99999999999" });
      expect(result.stderr).toContain("2147483647 (2**31 - 1)");
      expect(result.stderr).toContain("the largest delay setTimeout honours");
    },
    TIMEOUT,
  );

  it(
    "says what to do about it",
    async () => {
      const result = await boot({ MCP_GITHUB_GISTS_TIMEOUT_MS: "abc" });
      expect(result.stderr).toMatch(/Unset that variable|set a value/);
    },
    TIMEOUT,
  );
});

describe("the cookbook's two servers fail the same way", () => {
  it(
    "a good config still boots and advertises both tools",
    async () => {
      // The control. A guard that refused everything would pass every
      // assertion above.
      const result = await boot({ MCP_GITHUB_GISTS_TIMEOUT_MS: "5000" });
      expect(result.exited, result.stderr).toBe(false);
      expect(result.stdout).toContain("get_gist");
      expect(result.stdout).toContain("update_gist_file");
      expect(result.stderr).not.toContain("refusing to start");
    },
    TIMEOUT,
  );

  it(
    "boot-failure stderr matches the shape internal-tools-bridge uses",
    async () => {
      // This repo is a cookbook: the diagnostic is part of the pattern being
      // demonstrated, so the two servers must read the same. The bridge prints
      //   internal-tools-bridge: refusing to start. <detail>. <what to do>
      const result = await boot({ MCP_GITHUB_GISTS_TIMEOUT_MS: "abc" });
      expect(result.stderr.trim()).toMatch(
        /^[a-z-]+: refusing to start\. .+\. .+\.$/s,
      );
    },
    TIMEOUT,
  );
});
