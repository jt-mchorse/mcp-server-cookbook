#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { type SandboxConfig, readSandboxConfigFromEnv } from "./config.js";
import { Sandbox } from "./sandbox.js";
import {
  errorMessage,
  listDirectory,
  readFile,
  writeFile,
} from "./tools.js";

// Boot-time configuration failure, as one actionable line (#151).
//
// `readSandboxConfigFromEnv` already fails at the right *time* -- module scope,
// before any transport is attached -- which is the property #145 gave the
// bridge. The remaining gap was the diagnostic. Uncaught, this printed a Node
// unhandled-throw block: a `dist/` file path, a code frame, a caret and a
// seven-frame stack, wrapped around a message that was already good. Measured,
// 11 stderr lines against the 1 that `github-gists` prints since #146.
//
// `MCP_FS_SANDBOX_ALLOWLIST` has no default on purpose -- an allowlist that
// defaulted to something would be a sandbox that defaults to unsafe -- so the
// *missing required variable* is the ordinary first-run path, not a corner.
// That path is noise to someone following the README for the first time, and it
// arrives through an MCP client that may surface only the first line or two of
// stderr -- here, a compiled path and a fragment of source.
//
// The message is kept verbatim: it already names the variable and the bound,
// and that is the good part. Only the framing changes, to the shape #145
// established and #146 propagated: "<server>: refusing to start. <detail>."
// plus what to do about it. No variable name is hardcoded here:
// this server validates three (`MCP_FS_SANDBOX_ALLOWLIST`,
// `_MAX_BYTES`, `_READ_ONLY`) and the thrown message already names whichever
// one is at fault.
//
// `test/boot-config-failure.test.ts` spawns the real process, because no
// in-process test can observe what a module-scope throw prints (#145).
let cfg: SandboxConfig;
try {
  cfg = readSandboxConfigFromEnv();
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(
    `filesystem-sandbox: refusing to start. ${detail} ` +
      `Set that variable to a value meeting the requirement above, or unset it to use its default.`,
  );
  process.exit(1);
}

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
