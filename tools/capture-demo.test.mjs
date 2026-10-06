// Tests for tools/capture-demo.mjs.
//
// Uses node:test (stdlib) so this file runs alongside the existing
// `tools/check-*.test.mjs` suite with no extra deps. CI invokes:
//   node --test tools/capture-demo.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

test("extractFixtureGistId parses the gist_id line format", () => {
  assert.equal(extractFixtureGistId("`gist_id`: `0123abcdef_x-y`"), "0123abcdef_x-y");
  assert.equal(extractFixtureGistId("`gist_id`: `<unset>`"), null);
});

test("the committed fixture doc never presents a placeholder as a resolved gist id (#219)", () => {
  // It used to hold a made-up id beside "This is a placeholder"; the script
  // took its RESOLVED branch and printed it as the "Deterministic input",
  // which 404s. Either the doc pins a real id (and stops calling it a
  // placeholder), or it yields none and STAGE 3 says it is using one.
  const docText = readFileSync(path.join(REPO_ROOT, FIXTURE_DOC_PATH), "utf-8");
  const id = extractFixtureGistId(docText);
  if (id !== null) {
    assert.doesNotMatch(docText, /this is a placeholder|made-up/i);
  } else {
    assert.match(renderStage3Cheatsheet({ fixtureGistId: id }), /using placeholder/);
  }
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
  assert.ok(out.includes("docker compose up -d --wait"));
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

// Every `Tool: X` / `Args: { k: ... }` pair the cheatsheets print names
// argument keys the server actually declares (#182). Stage 3 printed `gistId`
// for a tool whose argument is `gist_id`, so an operator copying the
// cheatsheet into a client got a validation error instead of the recorded
// demo. The server entry points start a transport on import, so the check
// reads each tool's definition block out of the server's source.
const STAGE_SERVERS = [
  ["stage 1", () => renderStage1Cheatsheet({ seedSha256: "x", launched: false }), "servers/postgres-readonly/src/server.ts"],
  ["stage 2", () => renderStage2Cheatsheet({ sandboxRoot: "/tmp/r" }), "servers/filesystem-sandbox/src/server.ts"],
  ["stage 3", () => renderStage3Cheatsheet({ fixtureGistId: "abc123fixture" }), "servers/github-gists/src/server.ts"],
];

function printedCalls(out) {
  const calls = [];
  const re = /Tool: (\w+)\n#\s+Args: (\(none\)|\{.*\})/g;
  for (const m of out.matchAll(re)) {
    const keys = m[2] === "(none)" ? [] : [...m[2].matchAll(/[{,]\s*([A-Za-z_]\w*):/g)].map((k) => k[1]);
    calls.push({ tool: m[1], keys });
  }
  return calls;
}

function declaredProperties(source, tool) {
  const start = source.indexOf(`name: "${tool}"`);
  assert.ok(start >= 0, `tool ${tool} not defined in the server source`);
  const next = source.indexOf("\n    name: ", start + 1);
  const block = source.slice(start, next < 0 ? undefined : next);
  const props = block.slice(block.indexOf("properties: {"));
  return new Set([...props.matchAll(/^\s{8}([A-Za-z_]\w*): \{/gm)].map((m) => m[1]));
}

for (const [label, render, serverPath] of STAGE_SERVERS) {
  test(`${label} cheatsheet: every printed argument is one the tool declares (#182)`, () => {
    const source = readFileSync(path.join(REPO_ROOT, serverPath), "utf-8");
    const calls = printedCalls(render());
    assert.ok(calls.length >= 1, `${label}: no Tool/Args pairs parsed; the check would be vacuous`);
    for (const { tool, keys } of calls) {
      const declared = declaredProperties(source, tool);
      for (const k of keys) assert.ok(declared.has(k), `${label}: ${tool} prints '${k}', declared: ${[...declared]}`);
    }
  });
}

// --launch-postgres reports what actually happened (#193). The launch used to
// be `spawn(...)` in a try/catch: spawn never throws, so with no docker on
// PATH the script printed "docker compose started" and exited 0. These run
// the real script with PATH reduced to `node`, `sleep` and (optionally) a
// fake `docker` that records its arguments.
function runLaunch(dockerExit) {
  const bin = mkdtempSync(path.join(os.tmpdir(), "capture-launch-"));
  const argsFile = path.join(bin, "docker-args");
  try {
    symlinkSync(process.execPath, path.join(bin, "node"));
    symlinkSync("/bin/sleep", path.join(bin, "sleep"));
    if (dockerExit !== null) {
      writeFileSync(
        path.join(bin, "docker"),
        `#!/bin/sh\necho "$@" > "${argsFile}"\nexit ${dockerExit}\n`,
      );
      chmodSync(path.join(bin, "docker"), 0o755);
    }
    const proc = spawnSync(
      path.join(bin, "node"),
      [
        path.join(REPO_ROOT, "tools/capture-demo.mjs"),
        "--launch-postgres",
        "--pause-seconds",
        "0",
        "--skip-stage-2",
        "--skip-stage-3",
      ],
      { env: { PATH: bin }, encoding: "utf-8" },
    );
    const args = existsSync(argsFile) ? readFileSync(argsFile, "utf-8").trim() : null;
    return { out: proc.stdout + proc.stderr, status: proc.status, args };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

const UP = "docker compose is up";
const FAILED = "failed; cheat-sheet only";

test("--launch-postgres: a launch that succeeds waited for the healthcheck", () => {
  const r = runLaunch(0);
  assert.equal(r.args, "compose up -d --wait");
  assert.ok(r.out.includes(UP), r.out);
  assert.ok(!r.out.includes(FAILED), r.out);
});

test("--launch-postgres: a launch that fails says so", () => {
  const r = runLaunch(1);
  assert.ok(r.out.includes(FAILED), r.out);
  assert.ok(!r.out.includes(UP), r.out);
});

test("--launch-postgres: no docker on PATH says so", () => {
  const r = runLaunch(null);
  assert.ok(r.out.includes(FAILED), r.out);
  assert.ok(!r.out.includes(UP), r.out);
});

// ---------------------------------------------------------------------------
// #202: `--sandbox-root` used to `rm -rf` whatever directory it was given.
// ---------------------------------------------------------------------------

function scratch(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function captureMain(argv) {
  let captured = "";
  const rc = main(argv, { write: (s) => { captured += s; } });
  return { rc, captured };
}

const STAGE_2_ONLY = ["--pause-seconds", "0", "--skip-stage-1", "--skip-stage-3"];

test("#202: a root holding a foreign file is refused and the file survives", () => {
  const root = scratch("capture-demo-foreign-file-");
  writeFileSync(path.join(root, "notes.txt"), "keep me\n");
  assert.throws(
    () => buildSandboxLayout({ root, clean: true }),
    (err) => err.message.includes(path.join(root, "notes.txt")) && /not part of this script's layout/.test(err.message),
  );
  assert.equal(readFileSync(path.join(root, "notes.txt"), "utf-8"), "keep me\n");
});

test("#202: a foreign directory is refused, named by its first entry, and survives", () => {
  const root = scratch("capture-demo-foreign-dir-");
  buildSandboxLayout({ root, clean: true });
  mkdirSync(path.join(root, "important"));
  writeFileSync(path.join(root, "important", "notes.txt"), "keep me\n");
  assert.throws(() => buildSandboxLayout({ root, clean: true }), /important is not part of this script's layout/);
  assert.ok(existsSync(path.join(root, "important", "notes.txt")));
});

test("#202: a foreign file inside the owned nested/ directory is refused", () => {
  // The walk has to descend into the directories the layout owns: a check of
  // the top level alone passes this tree and deletes nested/mine.md.
  const root = scratch("capture-demo-foreign-nested-");
  buildSandboxLayout({ root, clean: true });
  writeFileSync(path.join(root, "nested", "mine.md"), "keep me\n");
  assert.throws(() => buildSandboxLayout({ root, clean: true }), /nested\/mine\.md is not part/);
  assert.ok(existsSync(path.join(root, "nested", "mine.md")));
});

test("#202: a symlink at an owned name is foreign; its target is not overwritten", () => {
  const root = scratch("capture-demo-symlink-name-");
  const target = path.join(scratch("capture-demo-symlink-target-"), "precious.txt");
  writeFileSync(target, "keep me\n");
  symlinkSync(target, path.join(root, "hello.txt"));
  assert.throws(() => buildSandboxLayout({ root, clean: false }), /hello\.txt is not part/);
  assert.equal(readFileSync(target, "utf-8"), "keep me\n");
});

test("#202: a root that is a file, or a symlink, is refused", () => {
  const dir = scratch("capture-demo-root-kind-");
  const file = path.join(dir, "a-file");
  writeFileSync(file, "keep me\n");
  assert.throws(() => buildSandboxLayout({ root: file, clean: true }), /is not a directory/);
  assert.equal(readFileSync(file, "utf-8"), "keep me\n");
  const link = path.join(dir, "a-link");
  symlinkSync(scratch("capture-demo-link-target-"), link);
  assert.throws(() => buildSandboxLayout({ root: link, clean: true }), /is a symlink/);
});

test("#202: a re-capture over its own layout, an empty directory and a new path all still build", () => {
  const own = scratch("capture-demo-own-");
  buildSandboxLayout({ root: own, clean: true });
  writeFileSync(path.join(own, "hello.txt"), "edited by hand\n"); // owned name, other content
  buildSandboxLayout({ root: own, clean: true });
  assert.equal(readFileSync(path.join(own, "hello.txt"), "utf-8"), SANDBOX_FILES[0].content);
  const empty = scratch("capture-demo-empty-");
  buildSandboxLayout({ root: empty, clean: true });
  const fresh = path.join(scratch("capture-demo-fresh-"), "not-yet");
  buildSandboxLayout({ root: fresh, clean: true });
  for (const root of [own, empty, fresh]) {
    for (const file of SANDBOX_FILES) {
      assert.equal(readFileSync(path.join(root, file.rel), "utf-8"), file.content);
    }
  }
});

test("#202: main refuses a foreign root with exit 2 before deleting anything", () => {
  const root = scratch("capture-demo-main-foreign-");
  writeFileSync(path.join(root, "notes.txt"), "keep me\n");
  const { rc, captured } = captureMain([...STAGE_2_ONLY, "--sandbox-root", root]);
  assert.equal(rc, 2, captured);
  assert.match(captured, /error: refusing to rebuild the sandbox layout/);
  assert.ok(!captured.includes("wrote deterministic allow-list layout"));
  assert.equal(readFileSync(path.join(root, "notes.txt"), "utf-8"), "keep me\n");
});

test("#202: the issue's repro through the real CLI exits 2 and keeps important/notes.txt", () => {
  const root = scratch("capture-demo-cli-");
  mkdirSync(path.join(root, "important"));
  writeFileSync(path.join(root, "important", "notes.txt"), "keep me\n");
  const r = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "tools/capture-demo.mjs"), ...STAGE_2_ONLY, "--sandbox-root", root],
    { encoding: "utf-8" },
  );
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(existsSync(path.join(root, "important", "notes.txt")));
});

for (const argv of [["--sandbox-root"], ["--sandbox-root", "--skip-stage-1"], ["--pause-seconds"], ["--pause-seconds", "--skip-stage-1"]]) {
  test(`#202: ${JSON.stringify(argv)} is a usage error, not a silent fallback`, () => {
    assert.throws(() => parseArgs(argv), new RegExp(`${argv[0]} needs a value`));
    const { rc, captured } = captureMain(argv);
    assert.equal(rc, 2);
    assert.ok(!captured.includes("undefined"), captured);
  });
}
