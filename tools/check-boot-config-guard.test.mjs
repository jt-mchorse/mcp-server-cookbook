// Tests for `check-boot-config-guard.mjs` (#151).
//
// The check is source-based, so its own failure modes are (a) passing a server
// that is broken and (b) failing a server that is fine. The second is not
// hypothetical: the first draft used a "no unindented config read" heuristic
// and flagged `internal-tools-bridge`, which builds its config at module scope
// and validates it in a separate try a few lines down. Both directions are
// pinned below.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { check, checkServer, typescriptServers } from "./check-boot-config-guard.mjs";

function fixture(servers) {
  const dir = mkdtempSync(join(tmpdir(), "boot-guard-"));
  for (const [name, src] of Object.entries(servers)) {
    mkdirSync(join(dir, name, "src"), { recursive: true });
    writeFileSync(join(dir, name, "src", "server.ts"), src, "utf8");
  }
  return dir;
}

const GOOD = (name) => `
let cfg;
try {
  cfg = readThingConfigFromEnv();
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(\`${name}: refusing to start. \${detail}\`);
  process.exit(1);
}
`;

test("the real repo passes", () => {
  assert.deepEqual(check(), []);
});

test("all four TypeScript servers are in scope", () => {
  // If this list ever shrinks silently, every assertion above passes by
  // covering less. The Python port is deliberately absent.
  assert.deepEqual(typescriptServers(), [
    "filesystem-sandbox",
    "github-gists",
    "internal-tools-bridge",
    "postgres-readonly",
  ]);
});

test("a server with no framing fails", () => {
  const dir = fixture({ "new-server": "const cfg = readThingConfigFromEnv();\n" });
  const problems = checkServer("new-server", dir);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /refusing to start/);
});

test("a server that prints the framing but never catches fails", () => {
  const dir = fixture({
    "new-server": `console.error("new-server: refusing to start. x");\nprocess.exit(1);\n`,
  });
  const problems = checkServer("new-server", dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no catch around its boot configuration/);
});

test("a server that catches but does not exit 1 fails", () => {
  const dir = fixture({
    "new-server": `try { x(); } catch (e) { console.error("new-server: refusing to start. y"); }\n`,
  });
  const problems = checkServer("new-server", dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not exit 1/);
});

test("a well-formed server passes", () => {
  const dir = fixture({ "new-server": GOOD("new-server") });
  assert.deepEqual(checkServer("new-server", dir), []);
});

test("the framing must name the server, not any server", () => {
  // A copy-paste from a sibling server is the realistic way to get this wrong.
  const dir = fixture({ "new-server": GOOD("github-gists") });
  const problems = checkServer("new-server", dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /new-server: refusing to start/);
});

test("a config built at module scope and validated in a separate try passes", () => {
  // The false positive the first draft produced, pinned so it cannot come back.
  const dir = fixture({
    "bridge-like": `
const cfg = defaultBridgeConfig(cwd);
try {
  validateBridgeConfig(cfg);
} catch (e) {
  console.error("bridge-like: refusing to start. " + String(e));
  process.exit(1);
}
`,
  });
  assert.deepEqual(checkServer("bridge-like", dir), []);
});

test("an empty servers dir is a failure, not a vacuous pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-guard-empty-"));
  const problems = check(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /would pass vacuously/);
});
