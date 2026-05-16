#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { readSandboxConfigFromEnv } from "./config.js";
import { Sandbox } from "./sandbox.js";
import {
  FileTooLargeError,
  WriteForbiddenError,
  isSandboxEscape,
  listDirectory,
  readFile,
  writeFile,
} from "./tools.js";

const cfg = readSandboxConfigFromEnv();

const server = new Server(
  {
    name: "filesystem-sandbox",
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
    name: "list_directory",
    description:
      "List entries (name, kind, size) inside an allow-listed directory. Path must be absolute and must resolve (after symlinks) under one of the configured allow-list roots.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a directory." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file under the allow-list. Files larger than MCP_FS_SANDBOX_MAX_BYTES (default 1 MB) are rejected. Non-UTF-8 content is rejected explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a regular file." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Write UTF-8 text to a path under the allow-list. The parent directory must exist and be inside the allow-list; symlinks pointing outside the allow-list are rejected. Disabled entirely when MCP_FS_SANDBOX_READ_ONLY=1.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to write." },
        content: { type: "string", description: "UTF-8 text contents." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  const sandbox = await sandboxPromise;
  const deps = { sandbox, readOnly: cfg.readOnly, maxBytes: cfg.maxBytes };

  try {
    switch (name) {
      case "list_directory": {
        const entries = await listDirectory(deps, a.path as string);
        return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
      }
      case "read_file": {
        const text = await readFile(deps, a.path as string);
        return { content: [{ type: "text" as const, text }] };
      }
      case "write_file": {
        const result = await writeFile(deps, a.path as string, a.content as string);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      default:
        return {
          content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true };
  }
});

function errorMessage(err: unknown): string {
  if (isSandboxEscape(err)) return `sandbox refusal (${err.reason}): ${err.input}`;
  if (err instanceof WriteForbiddenError) return err.message;
  if (err instanceof FileTooLargeError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

let sandboxPromise: Promise<Sandbox>;

async function main(): Promise<void> {
  sandboxPromise = Sandbox.create(cfg.allowedRoots);
  // Surface allow-list errors before the transport opens so the
  // operator sees them in stderr at boot, not on the first tool call.
  await sandboxPromise;
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("filesystem-sandbox MCP server failed:", e);
  process.exit(1);
});
