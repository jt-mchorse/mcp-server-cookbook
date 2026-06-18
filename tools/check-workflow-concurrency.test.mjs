// Tests for tools/check-workflow-concurrency.mjs.
//
// Uses node:test (stdlib) — matches the test pattern of the other
// tools/*.test.mjs files in this repo. Run as
// `node --test tools/check-workflow-concurrency.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkWorkflowFile, listWorkflowFiles, run } from "./check-workflow-concurrency.mjs";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeTempWorkflowsDir() {
  const root = mkdtempSync(path.join(tmpdir(), "check-workflow-concurrency-"));
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
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: echo ok
`;

const MISSING_CONCURRENCY = `name: ci
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: echo ok
`;

const MISSING_GROUP = `name: ci
on:
  push:
    branches: [main]
concurrency:
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: echo ok
`;

const EMPTY_GROUP = `name: ci
on:
  push:
    branches: [main]
concurrency:
  group: "   "
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: echo ok
`;

const MISSING_CANCEL = `name: ci
on:
  push:
    branches: [main]
concurrency:
  group: ci-\${{ github.ref }}
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: echo ok
`;

const STRING_CANCEL = `name: ci
on:
  push:
    branches: [main]
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: "true"
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: echo ok
`;

const FALSE_CANCEL = `name: ci
on:
  push:
    branches: [main]
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: echo ok
`;

test("checkWorkflowFile returns no findings on a clean workflow", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", CLEAN_WORKFLOW);
    const findings = checkWorkflowFile(file);
    assert.deepEqual(findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags missing concurrency block", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", MISSING_CONCURRENCY);
    const findings = checkWorkflowFile(file);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, "no-concurrency");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags missing group", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", MISSING_GROUP);
    const findings = checkWorkflowFile(file);
    assert.ok(findings.some((f) => f.code === "no-group"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags empty/whitespace group", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", EMPTY_GROUP);
    const findings = checkWorkflowFile(file);
    assert.ok(findings.some((f) => f.code === "group-empty"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags missing cancel-in-progress", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", MISSING_CANCEL);
    const findings = checkWorkflowFile(file);
    assert.ok(findings.some((f) => f.code === "no-cancel"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags string `'true'` cancel-in-progress (silent failure shape)", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", STRING_CANCEL);
    const findings = checkWorkflowFile(file);
    assert.ok(findings.some((f) => f.code === "cancel-not-bool"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags `false` cancel-in-progress (defeats the lock)", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", FALSE_CANCEL);
    const findings = checkWorkflowFile(file);
    assert.ok(findings.some((f) => f.code === "cancel-not-true"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkflowFiles returns sorted absolutes; empty array if dir missing", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    writeWorkflow(workflowsDir, "b.yml", CLEAN_WORKFLOW);
    writeWorkflow(workflowsDir, "a.yml", CLEAN_WORKFLOW);
    const files = listWorkflowFiles(workflowsDir);
    assert.equal(files.length, 2);
    assert.match(files[0], /a\.yml$/);
    assert.match(files[1], /b\.yml$/);
    const missing = listWorkflowFiles(path.join(root, "does-not-exist"));
    assert.deepEqual(missing, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run returns exit code 0 on a clean directory", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    writeWorkflow(workflowsDir, "ci.yml", CLEAN_WORKFLOW);
    const logs = [];
    const errs = [];
    const code = run({
      workflowsDir,
      log: (m) => logs.push(m),
      err: (m) => errs.push(m),
    });
    assert.equal(code, 0);
    assert.equal(errs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run returns exit code 1 on findings and prints the silent-quota-burn hint", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    writeWorkflow(workflowsDir, "ci.yml", MISSING_CONCURRENCY);
    const errs = [];
    const code = run({
      workflowsDir,
      log: () => {},
      err: (m) => errs.push(m),
    });
    assert.equal(code, 1);
    assert.ok(errs.some((m) => m.includes("FAIL")));
    assert.ok(errs.some((m) => m.includes("push-on-push")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run returns exit code 2 when the workflows directory is missing", () => {
  const { root } = makeTempWorkflowsDir();
  try {
    const missing = path.join(root, "does-not-exist");
    const errs = [];
    const code = run({
      workflowsDir: missing,
      log: () => {},
      err: (m) => errs.push(m),
    });
    assert.equal(code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run returns exit code 2 when the workflows directory is empty", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const errs = [];
    const code = run({
      workflowsDir,
      log: () => {},
      err: (m) => errs.push(m),
    });
    assert.equal(code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
