#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { type DbConfig, readDbConfigFromEnv } from "./db.js";
import { dispatchCallTool } from "./handler.js";

// Boot-time configuration failure, as one actionable line (#151).
//
// `readDbConfigFromEnv` already fails at the right *time* -- module scope,
// before any transport is attached -- which is the property #145 gave the
// bridge. The remaining gap was the diagnostic. Uncaught, this printed a Node
// unhandled-throw block: a `dist/` file path, a code frame, a caret and a
// seven-frame stack, wrapped around a message that was already good. Measured,
// 11 stderr lines against the 1 that `github-gists` prints since #146.
//
// `DATABASE_URL` has no default on purpose, so the *missing required variable*
// is the ordinary first-run path, not a corner.
// That path is noise to someone following the README for the first time, and it
// arrives through an MCP client that may surface only the first line or two of
// stderr -- here, a compiled path and a fragment of source.
//
// The message is kept verbatim: it already names the variable and the bound,
// and that is the good part. Only the framing changes, to the shape #145
// established and #146 propagated: "<server>: refusing to start. <detail>."
// plus what to do about it. No variable name is hardcoded here:
// this server validates `DATABASE_URL` plus its integer
// settings, and the thrown message already names whichever one is at fault.
//
// `test/boot-config-failure.test.ts` spawns the real process, because no
// in-process test can observe what a module-scope throw prints (#145).
let cfg: DbConfig;
try {
  cfg = readDbConfigFromEnv();
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(
    `postgres-readonly: refusing to start. ${detail} ` +
      `Set that variable to a value meeting the requirement above, or unset it to use its default.`,
  );
  process.exit(1);
}

const server = new Server(
  {
    name: "postgres-readonly",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const TOOLS = [
  {
    name: "describe_schema",
    description:
      "Describe the tables and columns in a Postgres schema. Read-only; introspects information_schema only.",
    inputSchema: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description: "Schema name. Defaults to 'public'. Must be a bare identifier.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_select",
    description:
      "Run a single SELECT (or WITH/VALUES/TABLE/EXPLAIN) statement. Multi-statement input, comments hiding writes, and any non-SELECT keyword are rejected before execution. Results are truncated at MAX_ROWS rows.",
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "A single SELECT-shaped SQL statement.",
        },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "sample_rows",
    description:
      "Return up to `limit` rows from `schema.table`. Schema and table are validated as bare identifiers; limit is capped at min(50, MAX_ROWS).",
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name. Defaults to 'public'." },
        table: { type: "string", description: "Table or view name." },
        limit: { type: "integer", description: "Row cap. Defaults to 10. Capped at 50." },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  return dispatchCallTool(name, a, cfg);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server now reads/writes via stdio. Process exits when the client closes stdin.
}

main().catch((e) => {
  console.error("postgres-readonly MCP server failed:", e);
  process.exit(1);
});
