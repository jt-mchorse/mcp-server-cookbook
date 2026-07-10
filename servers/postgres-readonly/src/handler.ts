import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { DbConfig } from "./db.js";
import { describeSchema, runSelect, sampleRows } from "./tools.js";

/**
 * Render a thrown error as safe display text for an `isError` result.
 *
 * pg's connection/query errors carry a plain `.message` (e.g.
 * `connect ECONNREFUSED …`, `password authentication failed for user …`)
 * that never embeds the connection-string password, so surfacing it
 * directly matches the sibling servers' `errorMessage` helpers
 * (filesystem-sandbox, github-gists, internal-tools-bridge).
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispatch one `tools/call` request against the read-only Postgres config.
 *
 * The whole switch is wrapped in a single try/catch that converts any thrown
 * error into an `isError: true` CallToolResult, mirroring the three sibling
 * TS servers. Without it, a connection failure (DB down, wrong/expired
 * `DATABASE_URL`, network/TLS error) or a mid-query error in `describe_schema`
 * throws out of `withClient` — whose connect/validate/SET run outside its own
 * try/finally — and the SDK converts the rejected handler into a JSON-RPC
 * `error { code: InternalError }` instead of the documented `isError` result
 * (see docs/architecture.md: "SERVER — result or isError → CLIENT"). #102.
 */
export async function dispatchCallTool(
  name: string,
  args: Record<string, unknown>,
  cfg: DbConfig,
): Promise<CallToolResult> {
  try {
    switch (name) {
      case "describe_schema":
        return (await describeSchema({ schema: args.schema as string | undefined }, cfg)) as CallToolResult;
      case "run_select":
        return (await runSelect({ sql: args.sql as string }, cfg)) as CallToolResult;
      case "sample_rows":
        return (await sampleRows(
          {
            schema: args.schema as string | undefined,
            table: args.table as string,
            limit: args.limit as number | undefined,
          },
          cfg,
        )) as CallToolResult;
      default:
        return {
          content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true };
  }
}
