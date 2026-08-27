#!/usr/bin/env node
//
// Every TypeScript server must refuse a bad boot config with ONE actionable
// line, not a Node unhandled-throw block (#151).
//
// `#145` fixed *when* `internal-tools-bridge` validates its environment;
// `#146` fixed *how* `github-gists` reports the failure, adopting the bridge's
// framing. Two of the four TypeScript servers had it. The other two read their
// config at module scope exactly the same way and were never wrapped, so a
// missing required variable -- the ordinary first-run experience, since
// `MCP_FS_SANDBOX_ALLOWLIST` and `DATABASE_URL` have no defaults by design --
// printed 11 stderr lines with a `dist/` path, a code frame, a caret and a
// seven-frame stack.
//
// The behaviour is tested per server by spawning the real process. This is the
// *structural* half: it fails when a server ships a module-scope config read
// that is not wrapped, so a fifth server cannot repeat the omission and a
// future refactor cannot quietly drop the wrapper from one of the four. A
// spawned behavioural test only covers the servers someone remembered to write
// one for; this covers the ones nobody did.
//
// Deliberately source-based. The property is "the throw is caught before it
// reaches Node's default handler", which is a property of the module's top
// level -- there is no runtime registry to introspect, and importing the module
// to find out would execute the very boot being checked.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS_DIR = join(ROOT, "servers");

/** Servers whose entry point is TypeScript. The Python port is out of scope: a
 *  Python traceback is not a Node unhandled-throw block and needs its own
 *  measurement rather than an assumed answer. */
export function typescriptServers(serversDir = SERVERS_DIR) {
  return readdirSync(serversDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(serversDir, name, "src", "server.ts")))
    .sort();
}

// Server directory names are `[a-z0-9-]+`, asserted below, so they can be used
// in a plain `includes()` with no regex escaping.
const NAME_SHAPE = /^[a-z0-9-]+$/;

export function checkServer(server, serversDir = SERVERS_DIR) {
  if (!NAME_SHAPE.test(server)) {
    return [`${server}: unexpected server directory name; this check assumes [a-z0-9-]+`];
  }
  const src = readFileSync(join(serversDir, server, "src", "server.ts"), "utf8");
  const problems = [];

  // The framing, verbatim. Deliberately the whole requirement rather than
  // "reads config outside a try": `internal-tools-bridge` legitimately builds
  // its config at module scope and validates it in a separate try a few lines
  // down, so a "no unindented config read" heuristic flags a correct file. A
  // source check that fails on code that is right is worse than no check --
  // the first draft of this file did exactly that, which is why the rule is
  // stated positively.
  if (!src.includes(`${server}: refusing to start.`)) {
    problems.push(
      `${server}: does not print "${server}: refusing to start." -- every server uses ` +
        `the same framing so an operator sees the same shape whichever one they run (#145/#146/#151)`,
    );
  }

  // The framing has to be reached from a catch, not printed unconditionally.
  if (!/\bcatch\s*\(/.test(src)) {
    problems.push(
      `${server}: has no catch around its boot configuration, so a throw still ` +
        `reaches Node's default handler (#151)`,
    );
  }

  if (!/process\.exit\(1\)/.test(src)) {
    problems.push(`${server}: does not exit 1 on a refused boot (#151)`);
  }
  return problems;
}

export function check(serversDir = SERVERS_DIR) {
  const servers = typescriptServers(serversDir);
  if (servers.length === 0) {
    return [`no TypeScript servers found under ${serversDir} -- this check would pass vacuously`];
  }
  return servers.flatMap((s) => checkServer(s, serversDir));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const problems = check();
  if (problems.length > 0) {
    for (const p of problems) console.error(`error: ${p}`);
    process.exit(1);
  }
  console.log(
    `boot-config guard ok: ${typescriptServers().length} TypeScript server(s) refuse a bad config with one line`,
  );
}
