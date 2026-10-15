/**
 * A capped error text never ends in half a surrogate pair (#282).
 *
 * `errorMessage` kept `stderr.slice(0, 500)`, and `slice` counts UTF-16 code
 * units. repo-stats echoes the `path` it was given into its stderr
 * (`--root does not exist: <abs path>`), so an emoji path put a lone high
 * surrogate at the end of the tool result. The TS SDK writes that as a bare
 * `\ud83d` escape. The MCP Python client's strict JSON parser then rejects the
 * whole response line ("unexpected end of hex escape"), and the call is never
 * answered. Measured with `mcp` 1.30.0: the aligned path was answered, and the
 * path one character longer hung until the client's own timeout.
 *
 * The end-to-end arms spawn the real server (via `tsx`, for the reason
 * `server-boot-config.test.ts` gives) because the cut lives in `server.ts`,
 * which cannot be imported without starting the transport.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { capCodeUnits } from "../src/bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "..", "src", "server.ts");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

const EMOJI = String.fromCodePoint(0x1f600); // two code units: 0xD83D 0xDE00
const HIGH = String.fromCharCode(0xd83d);

/** True when `s` has a surrogate code unit without its partner. */
function hasLoneSurrogate(s: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

describe("capCodeUnits", () => {
  it.each([
    ["short text is returned whole", "abc", 5, "abc"],
    ["text exactly at the cap is returned whole", "abcde", 5, "abcde"],
    ["a cut between two BMP characters keeps the cap", "abcdef", 3, "abc"],
    ["a cut after a whole pair keeps the pair", `a${EMOJI}bc`, 3, `a${EMOJI}`],
    ["a cut between the halves of a pair drops the high half", `ab${EMOJI}c`, 3, "ab"],
  ])("%s", (_name, text, cap, expected) => {
    const out = capCodeUnits(text, cap);
    expect(out).toBe(expected);
    expect(out.length).toBeLessThanOrEqual(cap);
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bridge-282-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function rpc(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

/** Spawn the server, call repo_stats once, and return the tool result text. */
async function callRepoStats(path: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [TSX_CLI, SERVER], {
      env: { ...process.env, MCP_BRIDGE_CWD: scratch },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const cap = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("no tools/call response within 20s"));
    }, 20_000);
    child.stdout.on("data", (d: Buffer) => {
      chunks.push(d);
      const lines = Buffer.concat(chunks).toString("utf-8").split("\n");
      for (const line of lines) {
        if (!line.includes('"id":2')) continue;
        clearTimeout(cap);
        child.kill();
        const msg = JSON.parse(line) as { result: { content: { text: string }[] } };
        resolvePromise(msg.result.content[0]!.text);
        return;
      }
    });
    child.stdin.write(
      rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "surrogate-test", version: "0" },
      }),
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(rpc(2, "tools/call", { name: "repo_stats", arguments: { path } }));
  });
}

/**
 * A missing path whose stderr line has the high half of an emoji at code unit
 * `index` (499 is the last unit the 500 cap keeps).
 */
function pathWithHighSurrogateAt(index: number): string {
  const prefix = `--root does not exist: ${scratch}/`;
  const pad = (index - prefix.length) % 2;
  return "a".repeat(pad) + EMOJI.repeat(300);
}

describe("repo_stats: a missing emoji path's stderr is capped on a code point (#282)", () => {
  it("the stderr cut at 500 does not end in a lone high surrogate", async () => {
    const path = pathWithHighSurrogateAt(499);
    // Precondition: the bare slice WOULD split this one.
    const stderr = `--root does not exist: ${scratch}/${path}\n`;
    expect(stderr.slice(0, 500).endsWith(HIGH)).toBe(true);

    const text = await callRepoStats(path);
    expect(text).toContain("--root does not exist");
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text.endsWith(stderr.slice(0, 499))).toBe(true);
  }, 30_000);

  it("a path whose cut already falls between whole pairs keeps all 500 units", async () => {
    const path = pathWithHighSurrogateAt(498);
    const stderr = `--root does not exist: ${scratch}/${path}\n`;
    expect(stderr.slice(0, 500).endsWith(EMOJI)).toBe(true);

    const text = await callRepoStats(path);
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text.endsWith(stderr.slice(0, 500))).toBe(true);
  }, 30_000);
});
