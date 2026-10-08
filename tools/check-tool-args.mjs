#!/usr/bin/env node
//
// Every TypeScript server enforces its published inputSchema (#197, D-014).
//
// The TS SDK does not validate a tool's `inputSchema`, so each server's
// CallTool handler must call `checkToolArgs` from `src/tool-args.ts` before it
// reads `arguments`. That module is copied into every TS server rather than
// shared (each server is its own package), so this script holds the copies
// to one another and holds every handler to the call:
//
//   1. every `servers/<name>/src/server.ts` has a sibling `src/tool-args.ts`;
//   2. all of those copies are byte-identical;
//   3. each `server.ts` imports `checkToolArgs` and calls it inside its
//      `setRequestHandler(CallToolRequestSchema, ...)` block.
//
// Exit codes: 0 clean, 1 drift (each problem printed), 2 no TS server found.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "./lib/strip-comments.mjs";
import { isMain } from "./lib/is-main.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `[name, serverDir]` for every server with a `src/server.ts`. */
export function tsServers(root = ROOT) {
  const dir = path.join(root, "servers");
  return readdirSync(dir)
    .sort()
    .map((name) => [name, path.join(dir, name)])
    .filter(([, d]) => existsSync(path.join(d, "src", "server.ts")));
}

/** The CallTool handler's body: from its registration to the next registration or EOF. */
export function callToolHandler(source) {
  const code = stripComments(source);
  const start = code.indexOf("setRequestHandler(CallToolRequestSchema");
  if (start === -1) return null;
  const next = code.indexOf("setRequestHandler(", start + 1);
  return code.slice(start, next === -1 ? undefined : next);
}

export function check(root = ROOT) {
  const servers = tsServers(root);
  const problems = [];
  const copies = new Map();
  for (const [name, dir] of servers) {
    const argsFile = path.join(dir, "src", "tool-args.ts");
    if (!existsSync(argsFile)) {
      problems.push(`${name}: missing src/tool-args.ts`);
    } else {
      copies.set(name, readFileSync(argsFile, "utf8"));
    }
    const server = readFileSync(path.join(dir, "src", "server.ts"), "utf8");
    if (!/import\s*\{[^}]*\bcheckToolArgs\b[^}]*\}\s*from\s*"\.\/tool-args\.js"/.test(server)) {
      problems.push(`${name}: server.ts does not import checkToolArgs from ./tool-args.js`);
    }
    const handler = callToolHandler(server);
    if (handler === null) {
      problems.push(`${name}: server.ts registers no CallTool handler`);
    } else if (!/\bcheckToolArgs\s*\(/.test(handler)) {
      problems.push(`${name}: the CallTool handler never calls checkToolArgs`);
    }
  }
  const distinct = new Set(copies.values());
  if (distinct.size > 1) {
    const [first] = copies.keys();
    for (const [name, text] of copies) {
      if (text !== copies.get(first)) {
        problems.push(`${name}: src/tool-args.ts differs from ${first}'s copy`);
      }
    }
  }
  return { servers: servers.map(([name]) => name), problems };
}

if (isMain(import.meta.url)) {
  const { servers, problems } = check();
  if (servers.length === 0) {
    console.error("check-tool-args: no TypeScript server found under servers/");
    process.exit(2);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-tool-args: ${p}`);
    process.exit(1);
  }
  console.log(`check-tool-args: ${servers.length} TypeScript servers enforce their inputSchema`);
}
