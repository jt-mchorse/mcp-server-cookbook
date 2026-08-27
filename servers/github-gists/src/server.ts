#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  GistsClient,
  GithubApiError,
  RequestTimeoutError,
  TokenRequiredError,
  formatGithubApiError,
} from "./client.js";
import { type GistsConfig, hasToken, readGistsConfigFromEnv } from "./config.js";
import { defaultToolDeps, getGist, updateGistFile } from "./tools.js";

// Boot-time configuration failure, as one actionable line (#146).
//
// `readGistsConfigFromEnv` already fails at the right *time* -- module scope,
// before any transport is attached -- which is the property #145 gave the
// bridge. The remaining gap was the diagnostic. Uncaught, this printed a Node
// unhandled-throw block: a `dist/config.js:43` file path, a code frame, a caret
// and a stack, wrapped around a message that was already good. That path is
// noise to someone who mistyped an environment variable, and it arrives through
// an MCP client that may surface only the first line or two of stderr.
//
// Measured before this change, `MCP_GITHUB_GISTS_TIMEOUT_MS=abc`:
//
//   file:///.../servers/github-gists/dist/config.js:43
//               throw new Error(`MCP_GITHUB_GISTS_TIMEOUT_MS must be a ...
//                     ^
//   Error: MCP_GITHUB_GISTS_TIMEOUT_MS must be a positive integer; got "abc"
//       at readGistsConfigFromEnv (file:///.../dist/config.js:43:19)
//
// The message is kept verbatim -- #143 made sure it names the variable and the
// bound, and it is the good part. Only the framing changes, to the shape
// `internal-tools-bridge` now uses: "<server>: refusing to start. <detail>."
// plus what to do about it. Unlike the bridge, no variable name is hardcoded
// here: this server validates three (`MCP_GITHUB_GISTS_BASE_URL`,
// `_USER_AGENT`, `_TIMEOUT_MS`) and the thrown message already names whichever
// one is at fault.
//
// `test/boot-config-failure.test.ts` spawns the real process, because no
// in-process test can observe what a module-scope throw prints.
let cfg: GistsConfig;
try {
  cfg = readGistsConfigFromEnv();
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(
    `github-gists: refusing to start. ${detail}. ` +
      `Unset that variable to use its default, or set a value meeting the requirement above.`,
  );
  process.exit(1);
}

const server = new Server(
  {
    name: "github-gists",
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
    name: "get_gist",
    description:
      "Read a GitHub Gist by id. Returns id, description, public flag, html_url, and an array of files (filename, size, language, content). Files over the per-call cap are returned with `truncated: true` and no content. Works without a token for public gists; uses `GITHUB_TOKEN` when set for higher rate limits and private gists.",
    inputSchema: {
      type: "object",
      properties: {
        gist_id: { type: "string", description: "GitHub Gist id." },
      },
      required: ["gist_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_gist_file",
    description:
      "Update one file inside an existing GitHub Gist. Requires `GITHUB_TOKEN` with the `gist` scope. Optionally also updates the gist description. Returns the post-update gist projection (same shape as `get_gist`). Token is never echoed in success or error responses.",
    inputSchema: {
      type: "object",
      properties: {
        gist_id: { type: "string", description: "GitHub Gist id." },
        filename: { type: "string", description: "Name of the file inside the gist to overwrite." },
        content: { type: "string", description: "New UTF-8 contents for the file." },
        description: { type: "string", description: "Optional new description for the gist." },
      },
      required: ["gist_id", "filename", "content"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const client = new GistsClient({ cfg });
const deps = defaultToolDeps(client);

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "get_gist": {
        const out = await getGist(deps, a.gist_id as string);
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
      }
      case "update_gist_file": {
        const out = await updateGistFile(deps, {
          gist_id: a.gist_id as string,
          filename: a.filename as string,
          content: a.content as string,
          description: a.description as string | undefined,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
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
  // Surface the API/timeout/auth errors directly — they're already
  // built to be safe to show (token redacted, body dropped). Everything
  // else falls through to a generic Error.message.
  if (err instanceof GithubApiError) return formatGithubApiError(err);
  if (err instanceof RequestTimeoutError) return err.message;
  if (err instanceof TokenRequiredError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  // Log auth posture once at boot (stderr) so the operator can confirm
  // the token was picked up — without echoing the value.
  console.error(
    `github-gists MCP server starting; base=${cfg.baseUrl} ` +
      `token=${hasToken(cfg) ? "present" : "absent (public gists only)"}`,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("github-gists MCP server failed:", e);
  process.exit(1);
});
