/**
 * The README's "Sample client invocation" lines get an answer (#182).
 *
 * They used to be `{"method":"tools/call",...}` with no `"jsonrpc":"2.0"` and
 * no `"id"`. That isn't a JSON-RPC request, and piping it into the server
 * printed the boot line and then nothing. This test pipes each documented line
 * into the real server and requires a response carrying the line's id. It also
 * checks each line's tool name and argument keys against what `tools/list`
 * publishes, so a line naming `gistId` (the argument is `gist_id`) fails too.
 *
 * Hermetic: `MCP_GITHUB_GISTS_BASE_URL` points at a closed local port, so a
 * call that gets past argument validation fails fast on connect. That still
 * produces a response, which is all "the line is answered" needs.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "..", "src", "server.ts");
const README = resolve(__dirname, "..", "README.md");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const TIMEOUT = 30_000;

interface Rpc {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/** Every `echo '{...}'` line in the README's sample block, parsed. */
function readmeSampleLines(): Rpc[] {
  const text = readFileSync(README, "utf-8");
  return [...text.matchAll(/^echo '(\{.*\})' \\$/gm)].map((m) => JSON.parse(m[1]) as Rpc);
}

/** Pipe `lines` into a fresh server; resolve with the parsed stdout messages. */
async function exchange(lines: string[], until: (msgs: Rpc[]) => boolean): Promise<Rpc[]> {
  return await new Promise<Rpc[]>((resolvePromise) => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.GITHUB_TOKEN;
    env.MCP_GITHUB_GISTS_BASE_URL = "http://127.0.0.1:9";
    env.MCP_GITHUB_GISTS_TIMEOUT_MS = "2000";
    const child = spawn(process.execPath, [TSX_CLI, SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    const msgs: Rpc[] = [];
    let buf = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      child.kill();
      resolvePromise(msgs);
    };
    child.stdout.on("data", (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) msgs.push(JSON.parse(line) as Rpc);
      }
      if (until(msgs)) finish();
    });
    child.on("exit", finish);
    for (const line of lines) child.stdin.write(`${line}\n`);
    const cap = setTimeout(finish, 15_000);
  });
}

describe("README sample requests (#182)", () => {
  const samples = readmeSampleLines();

  it("the README has the two documented sample lines", () => {
    // A floor, so a reworded block can't make the arms below check nothing.
    expect(samples.map((s) => s.params?.name)).toEqual(["get_gist", "update_gist_file"]);
  });

  it.each(samples.map((s) => [s.params?.name, s] as const))(
    "%s: is a JSON-RPC 2.0 request with an id",
    (_name, s) => {
      expect(s.jsonrpc).toBe("2.0");
      expect(typeof s.id === "number" || typeof s.id === "string").toBe(true);
      expect(s.method).toBe("tools/call");
    },
  );

  it(
    "each line names a published tool with arguments its inputSchema accepts",
    async () => {
      const list = JSON.stringify({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
      const msgs = await exchange([list], (m) => m.some((x) => x.id === "list"));
      const reply = msgs.find((x) => x.id === "list") as {
        result: { tools: { name: string; inputSchema: { properties: object; required?: string[] } }[] };
      };
      const tools = new Map(reply.result.tools.map((t) => [t.name, t.inputSchema]));
      for (const s of samples) {
        const schema = tools.get(s.params?.name ?? "");
        expect(schema, `README names unpublished tool ${s.params?.name}`).toBeDefined();
        const keys = Object.keys(s.params?.arguments ?? {});
        for (const k of keys) expect(Object.keys(schema!.properties), s.params?.name).toContain(k);
        for (const r of schema!.required ?? []) expect(keys, s.params?.name).toContain(r);
      }
    },
    TIMEOUT,
  );

  it(
    "piping the documented lines, verbatim, gets one response per line",
    async () => {
      const text = readFileSync(README, "utf-8");
      const raw = [...text.matchAll(/^echo '(\{.*\})' \\$/gm)].map((m) => m[1]);
      const ids = samples.map((s) => s.id);
      const msgs = await exchange(raw, (m) => ids.every((id) => m.some((x) => x.id === id)));
      expect(msgs.map((x) => x.id).sort()).toEqual([...ids].sort());
    },
    TIMEOUT,
  );
});
