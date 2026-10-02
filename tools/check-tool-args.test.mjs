// Unit tests for tools/check-tool-args.mjs (#197).

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { callToolHandler, check } from "./check-tool-args.mjs";
import { REPO_ROOT } from "./lib/tools-files.mjs";

function copyOfRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tool-args-"));
  for (const name of [
    "filesystem-sandbox",
    "internal-tools-bridge",
    "github-gists",
    "postgres-readonly",
  ]) {
    cpSync(join(REPO_ROOT, "servers", name, "src"), join(dir, "servers", name, "src"), {
      recursive: true,
    });
  }
  return dir;
}

test("the real repo is clean and has every TS server (non-zero control)", () => {
  const { servers, problems } = check(REPO_ROOT);
  assert.deepEqual(problems, []);
  assert.deepEqual(servers, [
    "filesystem-sandbox",
    "github-gists",
    "internal-tools-bridge",
    "postgres-readonly",
  ]);
});

test("a drifted copy is reported", () => {
  const dir = copyOfRepo();
  try {
    const f = join(dir, "servers", "github-gists", "src", "tool-args.ts");
    writeFileSync(f, readFileSync(f, "utf8") + "\n// drift\n");
    const { problems } = check(dir);
    assert.ok(problems.some((p) => p.includes("github-gists: src/tool-args.ts differs")), problems);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a handler that stops calling checkToolArgs is reported", () => {
  const dir = copyOfRepo();
  try {
    const f = join(dir, "servers", "postgres-readonly", "src", "server.ts");
    const src = readFileSync(f, "utf8").replace(
      /checkToolArgs\(schema as unknown as ToolInputSchema, args\)/,
      "null",
    );
    writeFileSync(f, src);
    const { problems } = check(dir);
    assert.deepEqual(problems, ["postgres-readonly: the CallTool handler never calls checkToolArgs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a call that survives only in a comment does not count", () => {
  const src = [
    "server.setRequestHandler(CallToolRequestSchema, async (req) => {",
    "  // checkToolArgs(schema, args)",
    "  return x;",
    "});",
  ].join("\n");
  assert.ok(!/checkToolArgs\s*\(/.test(callToolHandler(src)));
});

test("a missing copy is reported", () => {
  const dir = copyOfRepo();
  try {
    rmSync(join(dir, "servers", "internal-tools-bridge", "src", "tool-args.ts"));
    const { problems } = check(dir);
    assert.ok(problems.includes("internal-tools-bridge: missing src/tool-args.ts"), problems);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
