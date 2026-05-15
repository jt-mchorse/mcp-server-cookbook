#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { readDbConfigFromEnv } from "./db.js";
import {
  describeSchema,
  runSelect,
  sampleRows,
} from "./tools.js";

const cfg = readDbConfigFromEnv();

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

  switch (name) {
    case "describe_schema":
      return describeSchema({ schema: a.schema as string | undefined }, cfg) as Promise<CallToolResult>;
    case "run_select":
      return runSelect({ sql: a.sql as string }, cfg) as Promise<CallToolResult>;
    case "sample_rows":
      return sampleRows(
        {
          schema: a.schema as string | undefined,
          table: a.table as string,
          limit: a.limit as number | undefined,
        },
        cfg,
      ) as Promise<CallToolResult>;
    default:
      return {
        content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
        isError: true,
      };
  }
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
