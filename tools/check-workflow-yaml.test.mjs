// Tests for tools/check-workflow-yaml.mjs.
//
// Uses node:test (stdlib) so this file is runnable as
// `node --test tools/check-workflow-yaml.test.mjs` with only `yaml`
// (npm) installed at the repo root. Matches the test pattern of the
// other tools/*.test.mjs files in this repo.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkWorkflowFile,
  listWorkflowFiles,
  run,
} from "./check-workflow-yaml.mjs";

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeTempWorkflowsDir() {
  const root = mkdtempSync(path.join(tmpdir(), "check-workflow-yaml-"));
  const wf = path.join(root, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  return { root, workflowsDir: wf };
}

function writeWorkflow(workflowsDir, name, content) {
  const filePath = path.join(workflowsDir, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

const CLEAN_WORKFLOW = `name: ci
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;

const PORTFOLIO_OPS_27_SHAPE = `name: ci
on:
  push:
    branches: [main]
jobs:
  memory:
    runs-on: ubuntu-latest
    steps:
      - name: bad
        run: grep -q "id: D-001" MEMORY/core_decisions_ai.md
`;

test("checkWorkflowFile passes on a clean workflow", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", CLEAN_WORKFLOW);
    const result = checkWorkflowFile(file);
    assert.equal(result.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile fails with code=parse on the historical portfolio-ops#27 shape", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", PORTFOLIO_OPS_27_SHAPE);
    const result = checkWorkflowFile(file);
    assert.equal(result.ok, false);
    assert.equal(result.code, "parse");
    assert.match(result.message, /yaml\.parse/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile fails with code=no-jobs when jobs: is missing", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(
      workflowsDir,
      "ci.yml",
      "name: ci\non:\n  push:\n    branches: [main]\n",
    );
    const result = checkWorkflowFile(file);
    assert.equal(result.ok, false);
    assert.equal(result.code, "no-jobs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile fails with code=empty-jobs when jobs: is an empty mapping", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(
      workflowsDir,
      "ci.yml",
      "name: ci\non:\n  push:\n    branches: [main]\njobs: {}\n",
    );
    const result = checkWorkflowFile(file);
    assert.equal(result.ok, false);
    assert.equal(result.code, "empty-jobs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile fails with code=shape when top-level isn't a mapping", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", "- not\n- a\n- mapping\n");
    const result = checkWorkflowFile(file);
    assert.equal(result.ok, false);
    assert.equal(result.code, "shape");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkflowFiles returns sorted *.yml paths only", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    writeWorkflow(workflowsDir, "b.yml", CLEAN_WORKFLOW);
    writeWorkflow(workflowsDir, "a.yml", CLEAN_WORKFLOW);
    writeWorkflow(workflowsDir, "ignore.txt", "not a workflow");
    writeWorkflow(workflowsDir, "c.yml", CLEAN_WORKFLOW);
    const files = listWorkflowFiles(workflowsDir).map((f) =>
      path.basename(f),
    );
    assert.deepEqual(files, ["a.yml", "b.yml", "c.yml"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkflowFiles returns [] when the directory is missing", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(workflowsDir), false);
  assert.deepEqual(listWorkflowFiles(workflowsDir), []);
});

test("run exits 0 on a clean workflows directory", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    writeWorkflow(workflowsDir, "ci.yml", CLEAN_WORKFLOW);
    const code = run({ workflowsDir, log: () => {}, err: () => {} });
    assert.equal(code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run exits 1 when one workflow file fails", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    writeWorkflow(workflowsDir, "good.yml", CLEAN_WORKFLOW);
    writeWorkflow(workflowsDir, "bad.yml", PORTFOLIO_OPS_27_SHAPE);
    const code = run({ workflowsDir, log: () => {}, err: () => {} });
    assert.equal(code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run exits 2 when the workflows directory is missing", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "check-workflow-yaml-missing-"));
  try {
    const wf = path.join(tmp, ".github", "workflows");
    const code = run({ workflowsDir: wf, log: () => {}, err: () => {} });
    assert.equal(code, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("run exits 2 when the workflows directory has zero *.yml files", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    // workflowsDir is created but empty.
    const code = run({ workflowsDir, log: () => {}, err: () => {} });
    assert.equal(code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run is clean against the real .github/workflows/ directory", () => {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const realWorkflowsDir = path.resolve(
    __dirname,
    "..",
    ".github",
    "workflows",
  );
  if (!existsSync(realWorkflowsDir)) {
    // No workflows dir → nothing to lock. Skip.
    return;
  }
  const code = run({ workflowsDir: realWorkflowsDir, log: () => {}, err: () => {} });
  assert.equal(code, 0, "real .github/workflows/ should be clean");
});
