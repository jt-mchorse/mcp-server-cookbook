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
} from "./bridge.js";
import { defaultBridgeConfig, repoStats, ToolInputError } from "./tools.js";

const cwd = process.env.MCP_BRIDGE_CWD ?? process.cwd();
const cfg = defaultBridgeConfig(cwd);

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
