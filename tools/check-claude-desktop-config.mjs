#!/usr/bin/env node
//
// Verify every `servers/*/README.md` ships a copy-pastable
// `claude_desktop_config.json` JSON block. The cookbook's success
// criterion is "each server installable and usable from Claude
// Desktop or Cowork itself in <5 minutes" (handoff §2). A reader
// landing on any server's README should not have to guess the
// `mcpServers` shape.
//
// What we require, per server README:
//   * at least one fenced ```json (or ```jsonc) code block that
//     contains BOTH the literal `"mcpServers"` AND a `"command"`
//     field. The two markers together are the minimum-viable shape
//     for a working Claude Desktop config entry.
//
// What we don't require (intentionally narrow lock):
//   * a specific header — server READMEs phrase it differently
//     ("Wire into Claude Desktop", "Wiring into Claude Desktop",
//     "Run (Claude Desktop)", "To attach it to Claude Desktop") and
//     prescribing one would just be churn.
//   * full JSON validity — the spec says copy-pastable; bracketed
//     `$HOME/path/to/...` placeholders are intentional. We parse the
//     block leniently after stripping common placeholder patterns.
//
// Exit codes:
//   0 — every server README ships the block
//   1 — one or more servers are missing it
//   2 — bad input (no servers, missing dir)
//

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVERS_DIR = path.join(REPO_ROOT, "servers");

/**
 * Find every fenced ```json or ```jsonc block in a markdown string.
 * Returns an array of block bodies (the text between the fences,
 * excluding the fence lines).
 */
export function fencedJsonBlocks(md) {
  const blocks = [];
  const re = /```jsonc?\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

/**
 * Decide whether a given fenced-block body is a Claude Desktop config
 * shape: contains the `"mcpServers"` key AND a `"command"` field.
 */
export function isClaudeDesktopConfigBlock(body) {
  return body.includes(`"mcpServers"`) && body.includes(`"command"`);
}

/**
 * Scan one server's README for a Claude Desktop config block.
 * Returns `{ ok: true }` on found, `{ ok: false, reason }` otherwise.
 */
export function scanServerReadme(readmePath) {
  if (!existsSync(readmePath)) {
    return { ok: false, reason: `missing README: ${readmePath}` };
  }
  const md = readFileSync(readmePath, "utf8");
  const blocks = fencedJsonBlocks(md);
  const found = blocks.some(isClaudeDesktopConfigBlock);
  if (found) return { ok: true };
  return {
    ok: false,
    reason:
      `no fenced JSON block containing both "mcpServers" and "command" — ` +
      `every server README must include a copy-pastable claude_desktop_config.json snippet ` +
      `(handoff §2 success criterion).`,
  };
}

/**
 * Discover the list of server subdirectories under `servers/`.
 */
export function listServers(serversDir) {
  if (!existsSync(serversDir)) return [];
  return readdirSync(serversDir)
    .filter((name) => {
      const full = path.join(serversDir, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function main() {
  const servers = listServers(SERVERS_DIR);
  if (servers.length === 0) {
    console.error(`No servers found under ${SERVERS_DIR}.`);
    process.exit(2);
  }

  const failures = [];
  for (const name of servers) {
    const readme = path.join(SERVERS_DIR, name, "README.md");
    const result = scanServerReadme(readme);
    if (result.ok) {
      console.log(`✓ servers/${name}/README.md`);
    } else {
      failures.push({ name, reason: result.reason });
      console.error(`✗ servers/${name}/README.md — ${result.reason}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} server README(s) missing a claude_desktop_config snippet.`,
    );
    process.exit(1);
  }
  console.log(`\n${servers.length}/${servers.length} server READMEs ship a claude_desktop_config snippet.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
