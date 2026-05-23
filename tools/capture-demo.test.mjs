// Tests for tools/capture-demo.mjs.
//
// Uses node:test (stdlib) so this file runs alongside the existing
// `tools/check-*.test.mjs` suite with no extra deps. CI invokes:
//   node --test tools/capture-demo.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REPO_ROOT,
  POSTGRES_SEED_PATH,
  SANDBOX_ROOT,
  SANDBOX_FILES,
  FIXTURE_DOC_PATH,
  sha256OfFile,
  banner,
  buildSandboxLayout,
  extractFixtureGistId,
  renderStage1Cheatsheet,
  renderStage2Cheatsheet,
  renderStage3Cheatsheet,
  parseArgs,
  main,
} from "./capture-demo.mjs";

test("sha256OfFile produces a 64-char hex digest", () => {
  const seedPath = path.join(REPO_ROOT, POSTGRES_SEED_PATH);
  assert.ok(existsSync(seedPath), `expected the seed file to exist at ${seedPath}`);
  const digest = sha256OfFile(seedPath);
  assert.match(digest, /^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex chars");
});

test("buildSandboxLayout creates the expected files (idempotent)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "capture-demo-test-"));
  const dest = path.join(tmp, "allow-list");
  const out1 = buildSandboxLayout({ root: dest, clean: true });
  assert.equal(out1, dest);
  for (const file of SANDBOX_FILES) {
    const full = path.join(dest, file.rel);
    assert.ok(existsSync(full), `expected ${full} to exist`);
    assert.equal(readFileSync(full, "utf-8"), file.content);
  }
  // Second run with clean=true should still produce identical content.
  buildSandboxLayout({ root: dest, clean: true });
  for (const file of SANDBOX_FILES) {
    assert.equal(
      readFileSync(path.join(dest, file.rel), "utf-8"),
      file.content,
      "rebuild must be byte-for-byte identical so re-captures are deterministic",
    );
  }
});

test("extractFixtureGistId parses the gist_id line from the demo fixture doc", () => {
  // The committed doc must contain a gist_id token — script falls
  // back to a placeholder if not, but that's a demo-quality
  // degradation, not an invariant we want silently.
  const docText = readFileSync(path.join(REPO_ROOT, FIXTURE_DOC_PATH), "utf-8");
  const id = extractFixtureGistId(docText);
  assert.ok(id, `expected a gist_id in ${FIXTURE_DOC_PATH}`);
  assert.match(id, /^[A-Za-z0-9_-]+$/);
});

test("extractFixtureGistId returns null when the format isn't matched", () => {
  assert.equal(extractFixtureGistId("no gist id here"), null);
});

test("renderStage1Cheatsheet includes the sha256, docker steps, and both tool calls", () => {
  const out = renderStage1Cheatsheet({
    seedSha256: "a".repeat(64),
    launched: false,
  });
  assert.match(out, /sha256\(servers\/postgres-readonly\/sample-db\/init\.sql\) = a{64}/);
  assert.ok(out.includes("docker compose up -d"));
  assert.ok(out.includes("Tool: describe_schema"));
  assert.ok(out.includes("Tool: run_select"));
  assert.ok(out.includes("D-004"));
});

test("renderStage2Cheatsheet includes the env var + both read_file invocations", () => {
  const out = renderStage2Cheatsheet({ sandboxRoot: SANDBOX_ROOT });
  assert.ok(out.includes(`MCP_FS_SANDBOX_ALLOWLIST=${SANDBOX_ROOT}`));
  assert.ok(out.includes("Tool: read_file"));
  // Both invocations present — success and traversal.
  const readFileCount = out.split("Tool: read_file").length - 1;
  assert.equal(readFileCount, 2, "expected exactly two read_file invocation blocks");
  assert.ok(out.includes("/etc/passwd"));
});

test("renderStage3Cheatsheet surfaces the fixture gist id when supplied", () => {
  const out = renderStage3Cheatsheet({ fixtureGistId: "abc123fixture" });
  assert.ok(out.includes("abc123fixture"));
  assert.ok(out.includes("Tool: get_gist"));
  assert.ok(out.includes("D-007"));
  // Both invocations present — success and error path.
  const getGistCount = out.split("Tool: get_gist").length - 1;
  assert.equal(getGistCount, 2);
});

test("renderStage3Cheatsheet falls back to placeholder when gist id is null", () => {
  const out = renderStage3Cheatsheet({ fixtureGistId: null });
  assert.ok(out.includes("<paste-a-public-gist-id-here>"));
});

test("parseArgs accepts all documented flags", () => {
  const a = parseArgs([
    "--pause-seconds", "0",
    "--launch-postgres",
    "--skip-stage-3",
  ]);
  assert.equal(a.pauseSeconds, 0);
  assert.equal(a.launchPostgres, true);
  assert.equal(a.skipStage3, true);
});

test("parseArgs rejects unknown args", () => {
  assert.throws(() => parseArgs(["--not-a-flag"]), /unknown argument/);
});

test("banner renders a fixed-width line", () => {
  const b = banner(1, "title");
  // Banner has two rule lines + the title line — three newline-separated parts.
  const lines = b.split("\n").filter((line) => line.length > 0);
  // First rule, title row, second rule.
  assert.equal(lines.length, 3);
  assert.equal(lines[0].length, 72);
  assert.equal(lines[2].length, 72);
  assert.ok(lines[1].includes("STAGE 1"));
  assert.ok(lines[1].includes("title"));
});

test("main runs all three stages and returns 0 on a clean repo", () => {
  // Capture stdout into a string buffer.
  let captured = "";
  const fakeOut = {
    write: (s) => {
      captured += s;
    },
  };
  const tmp = mkdtempSync(path.join(os.tmpdir(), "capture-demo-main-"));
  const rc = main(
    ["--pause-seconds", "0", "--sandbox-root", tmp],
    fakeOut,
  );
  assert.equal(rc, 0, `main exited ${rc}; captured:\n${captured}`);
  assert.ok(captured.includes("STAGE 1"));
  assert.ok(captured.includes("STAGE 2"));
  assert.ok(captured.includes("STAGE 3"));
  // Sandbox layout actually materialized at the requested root.
  for (const file of SANDBOX_FILES) {
    assert.ok(existsSync(path.join(tmp, file.rel)));
  }
});

test("main with --skip-stage flags suppresses the stage body", () => {
  let captured = "";
  const fakeOut = {
    write: (s) => {
      captured += s;
    },
  };
  const tmp = mkdtempSync(path.join(os.tmpdir(), "capture-demo-main-skip-"));
  const rc = main(
    [
      "--pause-seconds", "0",
      "--sandbox-root", tmp,
      "--skip-stage-1",
      "--skip-stage-3",
    ],
    fakeOut,
  );
  assert.equal(rc, 0);
  assert.ok(!captured.includes("STAGE 1"));
  assert.ok(captured.includes("STAGE 2"));
  assert.ok(!captured.includes("STAGE 3"));
});

test("main with --help prints usage and exits 0", () => {
  let captured = "";
  const fakeOut = {
    write: (s) => {
      captured += s;
    },
  };
  const rc = main(["--help"], fakeOut);
  assert.equal(rc, 0);
  assert.ok(captured.includes("Usage:"));
  assert.ok(captured.includes("--launch-postgres"));
});
