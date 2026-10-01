// Unit tests for tools/check-env-example.mjs (#185).

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { check, envNamesListed, envNamesRead, serversAndReads } from "./check-env-example.mjs";
import { REPO_ROOT } from "./lib/tools-files.mjs";

test("the TypeScript reader sees every spelling this repo uses", () => {
  const code = [
    "const a = process.env.A_1;",
    'const b = process.env["B"];',
    "const c = env.C;",
    "const d = env['D'];",
    'const e = parseIntEnv("E", 1000);',
  ].join("\n");
  assert.deepEqual(envNamesRead(code, "ts"), ["A_1", "B", "C", "D", "E"]);
});

test("the TypeScript reader ignores comments and look-alikes", () => {
  const code = [
    "// process.env.IN_A_LINE_COMMENT",
    "/* env.IN_A_BLOCK_COMMENT */",
    "const x = 1; // trailing: process.env.TRAILING",
    "const y = someenv.NOT_ENV;",
    "const z = cfg.env.NESTED;",
    'const url = "https://api.github.com"; const t = env.AFTER_A_URL;',
  ].join("\n");
  assert.deepEqual(envNamesRead(code, "ts"), ["AFTER_A_URL"]);
});

test("the Python reader sees every spelling and ignores prose", () => {
  const code = [
    '"""',
    'Docstring naming e.get("IN_A_DOCSTRING").',
    '"""',
    '# e.get("IN_A_COMMENT")',
    'a = e.get("A", "")',
    "b = env.get('B')",
    'c = os.environ.get("C")',
    'd = os.getenv("D")',
    'f = os.environ["F"]',
    'g = config.get("NOT_ENV")',
  ].join("\n");
  assert.deepEqual(envNamesRead(code, "py"), ["A", "B", "C", "D", "F"]);
});

test("a listed name is NAME= at the start of a line, comments excluded", () => {
  const text = "# NOT_THIS=1\nA=1\nB=\n  C=indented\nD_2=x\n";
  assert.deepEqual(envNamesListed(text), ["A", "B", "D_2"]);
});

test("every server's discovery finds its reads", () => {
  // A floor per server, so a walk or reader regression cannot make the
  // equality below compare two empty sets. The named reads are the ones each
  // server cannot boot or authenticate without.
  const reads = serversAndReads();
  assert.ok(reads["filesystem-sandbox"].includes("MCP_FS_SANDBOX_ALLOWLIST"));
  assert.ok(reads["filesystem-sandbox-py"].includes("MCP_FS_SANDBOX_ALLOWLIST"));
  assert.ok(reads["github-gists"].includes("GITHUB_TOKEN"));
  assert.ok(reads["internal-tools-bridge"].includes("MCP_BRIDGE_CWD"));
  // Read through `parseIntEnv`, the spelling a `process.env` grep misses.
  assert.ok(reads["postgres-readonly"].includes("MAX_ROWS"));
});

test("the shipped servers pass", () => {
  assert.deepEqual(check().failures, []);
});

function withRepoCopy(fn) {
  const dir = mkdtempSync(join(tmpdir(), "env-example-"));
  try {
    cpSync(join(REPO_ROOT, "servers"), join(dir, "servers"), {
      recursive: true,
      filter: (src) => !/[/\\](node_modules|dist|\.venv)([/\\]|$)/.test(src),
    });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a missing file fails, naming the server and what it reads", () => {
  withRepoCopy((dir) => {
    rmSync(join(dir, "servers/github-gists/.env.example"));
    const { failures } = check(dir);
    assert.equal(failures.length, 1, failures.join("\n"));
    assert.match(failures[0], /github-gists\/\.env\.example: missing.*GITHUB_TOKEN/);
  });
});

test("an unlisted read fails, and so does a listed name nobody reads", () => {
  withRepoCopy((dir) => {
    const p = join(dir, "servers/internal-tools-bridge/.env.example");
    writeFileSync(p, readFileSync(p, "utf8").replace("MCP_BRIDGE_CWD=", "MCP_BRIDGE_TYPO="));
    const { failures } = check(dir);
    assert.deepEqual(failures.sort(), [
      "servers/internal-tools-bridge/.env.example: does not list MCP_BRIDGE_CWD, which the server reads",
      "servers/internal-tools-bridge/.env.example: lists MCP_BRIDGE_TYPO, which nothing in the server reads",
    ]);
  });
});
