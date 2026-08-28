/**
 * A bad boot config prints one actionable line, not a stack (#151).
 *
 * `#145` fixed *when* `internal-tools-bridge` validates its environment; `#146`
 * fixed *how* `github-gists` reports the failure. This server already failed at
 * the right time -- `server.ts` calls `readDbConfigFromEnv()` at module scope,
 * before any transport is attached -- and was one of the two of four TypeScript
 * servers that never got the framing. Measured before this change:
 *
 *     file:///.../servers/postgres-readonly/dist/db.js:NN
 *             throw new Error("DATABASE_URL is required. Use a connection string for a READ-ONLY role; ...
 *                   ^
 *     Error: DATABASE_URL is required. Use a connection string for a READ-ONLY role; ...
 *         at readDbConfigFromEnv (file:///.../dist/db.js:NN:NN)
 *         ... 6 more frames
 *
 * 11 stderr lines, against the 1 `github-gists` has printed since #146.
 *
 * `DATABASE_URL` has no default on purpose, so the *missing required variable* is
 * the ordinary first-run path, not a corner.
 *
 * The *message* is kept verbatim -- it already names the variable and the bound.
 * Only the framing changes.
 *
 * These tests **spawn the real process**. Every other test in this server calls
 * the config functions in process, so not one of them can observe what a
 * module-scope throw prints -- the structural blind spot `#145` recorded.
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
    const baseEnv: Record<string, string | undefined> = { ...process.env };
    for (const key of CONFIG_KEYS) delete baseEnv[key];
    const child = spawn(process.execPath, [TSX_CLI, SERVER], {
      env: { ...baseEnv, ...env },
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
      // waiting a fixed interval.
      if (stdout.includes("run_select")) finish(false, null);
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

const DSN = "postgres://u:p@localhost:5432/d";

const GOOD_ENV: Record<string, string> = { DATABASE_URL: DSN };

/**
 * The variables this server reads. `boot` DELETES these from the child's
 * environment before applying a case, rather than setting them to `""`.
 * An empty string is not `undefined`: `parseIntEnv` returns its default only
 * for `undefined`, so blanking a numeric variable makes `Number.parseInt("")`
 * NaN and throws -- which would have made the "a good config boots" case fail
 * for the wrong reason, and a developer's own shell could otherwise decide
 * whether a "missing required variable" case is really missing.
 */
const CONFIG_KEYS: ReadonlyArray<string> = ["DATABASE_URL", "MAX_ROWS", "STATEMENT_TIMEOUT_MS"];

const TIMEOUT = 30_000;

// (label, env). `env` REPLACES the inherited values for the keys it names; the
// helper below blanks the required ones first so a developer's own shell
// environment cannot make a "missing required variable" case pass by accident.
const BAD_ENVS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["missing required DATABASE_URL", {}],
  ["non-numeric MAX_ROWS", { DATABASE_URL: DSN, MAX_ROWS: "abc" }],
  ["zero MAX_ROWS", { DATABASE_URL: DSN, MAX_ROWS: "0" }],
  ["negative STATEMENT_TIMEOUT_MS", { DATABASE_URL: DSN, STATEMENT_TIMEOUT_MS: "-1" }],
];

describe("postgres-readonly refuses a bad boot config with one line", () => {
  it.each(BAD_ENVS)(
    "%s: exits 1 and never advertises a tool",
    async (_label, env) => {
      const result = await boot(env);
      expect(result.exited, "server kept running with a rejected config").toBe(true);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("run_select");
    },
    TIMEOUT,
  );

  it.each(BAD_ENVS)(
    "%s: stderr is one actionable line, not a stack trace",
    async (_label, env) => {
      const result = await boot(env);
      const lines = result.stderr.trim().split("\n").filter(Boolean);
      expect(lines, result.stderr).toHaveLength(1);
      expect(lines[0]).toMatch(/^postgres-readonly: refusing to start\./);
      // The three things a stack trace brings and an operator does not need.
      expect(result.stderr).not.toContain("    at ");
      expect(result.stderr).not.toContain("file:///");
      expect(result.stderr).not.toMatch(/^\s*\^\s*$/m);
    },
    TIMEOUT,
  );

  it(
    "the underlying message is preserved verbatim, not replaced",
    async () => {
      const result = await boot(BAD_ENVS[0][1]);
      // #143-era work made these messages name the variable and the bound. The
      // framing must wrap that, not paraphrase it.
      expect(result.stderr).toContain("READ-ONLY role");
    },
    TIMEOUT,
  );

  it(
    "a good config still boots and serves",
    async () => {
      const result = await boot(GOOD_ENV);
      expect(result.stderr).not.toContain("refusing to start");
      expect(result.stdout).toContain("run_select");
    },
    TIMEOUT,
  );
});

describe("a unit-suffixed duration IS refused (#152)", () => {
  it(
    "STATEMENT_TIMEOUT_MS=5s refuses the boot instead of meaning five milliseconds",
    async () => {
      // This assertion was inverted by #152, deliberately. #151 pinned it at
      // CURRENT behaviour -- `parseIntEnv` used `Number.parseInt`, which stops
      // at the first character it cannot consume, so "5s" was accepted as 5: a
      // timeout 1000x tighter than the operator asked for, silently, with the
      // config file still reading "5s". The pin existed so that closing #152
      // would be a deliberate edit here rather than an unexplained change in a
      // neighbouring test. This is that edit.
      const result = await boot({ DATABASE_URL: DSN, STATEMENT_TIMEOUT_MS: "5s" });
      expect(result.stderr).toContain("refusing to start");
      expect(result.stderr).toContain("STATEMENT_TIMEOUT_MS");
      expect(result.stderr).toContain('"5s"');
      expect(result.stdout).not.toContain("run_select");
    },
    TIMEOUT,
  );
});
