#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  AllowlistError,
  BridgeError,
  NonZeroExitError,
  OutputCapError,
  TimeoutError,
  validateBridgeConfig,
} from "./bridge.js";
import { defaultBridgeConfig, repoStats, ToolInputError } from "./tools.js";

// `??` fires on `null`/`undefined` only, so `MCP_BRIDGE_CWD=` -- what a
// `docker run -e MCP_BRIDGE_CWD` with nothing after it produces, and what an
// empty line in an env file produces -- used to be taken verbatim as `""`
// instead of falling back to `process.cwd()` (#145). Same shape as
// nextjs-streaming-ai-patterns#104 and ai-app-integration-tests#101.
const cwdRaw = (process.env.MCP_BRIDGE_CWD ?? "").trim();
const cwd = cwdRaw.length > 0 ? cwdRaw : process.cwd();
const cfg = defaultBridgeConfig(cwd);

// Validate before anything is served. Previously the only `validateConfig`
// call was inside `runBridged`, so a server with an unusable `MCP_BRIDGE_CWD`
// booted, completed the handshake, and advertised `repo_stats` in
// `tools/list` -- then failed the call. Measured over a real stdio session:
//
//   MCP_BRIDGE_CWD=''          boot: STILL RUNNING, tools/list ADVERTISED repo_stats
//   MCP_BRIDGE_CWD='./rel'     boot: STILL RUNNING, tools/list ADVERTISED repo_stats
//   github-gists, bad timeout  boot: EXITED code=1, no tools/list response
//
// A broken bridge looked healthy to a client, and an agent had already chosen
// the tool by the time the error arrived. `github-gists` has always failed at
// boot for the same class; the two servers in this cookbook now demonstrate
// one pattern instead of two (#145).
//
// The message names `MCP_BRIDGE_CWD` because that is what the operator typed;
// `BridgeConfig.cwd` is an implementation detail they never saw.
try {
  validateBridgeConfig(cfg);
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(
    `internal-tools-bridge: refusing to start. MCP_BRIDGE_CWD=` +
      `${JSON.stringify(process.env.MCP_BRIDGE_CWD ?? null)} is not usable: ${detail}. ` +
      `Set it to an absolute path, or leave it unset to use the process working directory.`,
  );
  process.exit(1);
}

const server = new Server(
  { name: "internal-tools-bridge", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "repo_stats",
    description:
      "Walk a directory and return file counts by extension plus total bytes. Wraps the bundled `bin/repo-stats.mjs` CLI. Spawn is shell-free (D-009): args are passed as an array, the binary is allow-listed, env is scrubbed, output is capped, and a 10s timeout fires SIGKILL on overrun.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to walk. Resolved by the bundled CLI against its cwd.",
        },
        max_depth: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum recursion depth. Defaults to 4.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "repo_stats": {
        const out = await repoStats(cfg, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
        };
      }
      default:
        return {
          content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: errorMessage(err) }],
      isError: true,
    };
  }
});

function errorMessage(err: unknown): string {
  // Typed bridge errors carry messages that are already safe to show —
  // they describe the failure shape, never echo args or env.
  if (err instanceof ToolInputError) return `input error: ${err.message}`;
  if (err instanceof AllowlistError) return err.message;
  if (err instanceof TimeoutError) return err.message;
  if (err instanceof OutputCapError) return err.message;
  if (err instanceof NonZeroExitError) {
    return `${err.message}${err.stderr ? `; stderr: ${err.stderr.slice(0, 500)}` : ""}`;
  }
  if (err instanceof BridgeError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  console.error(
    `internal-tools-bridge MCP server starting; cwd=${cwd} ` +
      `node=${process.execPath}`,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("internal-tools-bridge MCP server failed:", e);
  process.exit(1);
});
