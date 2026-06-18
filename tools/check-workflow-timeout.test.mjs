// Tests for tools/check-workflow-timeout.mjs.
//
// Uses node:test (stdlib) — matches the test pattern of the other
// tools/*.test.mjs files in this repo. Run as
// `node --test tools/check-workflow-timeout.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkWorkflowFile,
  listWorkflowFiles,
  run,
  MIN_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
} from "./check-workflow-timeout.mjs";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeTempWorkflowsDir() {
  const root = mkdtempSync(path.join(tmpdir(), "check-workflow-timeout-"));
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
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: echo ok
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: echo ok
`;

const ONE_UNGUARDED = `name: ci
on:
  push:
    branches: [main]
jobs:
  guarded:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: echo ok
  unguarded:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;

const ALL_UNGUARDED = `name: ci
on:
  push:
    branches: [main]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`;

const STRING_VALUE = `name: ci
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: "15"
    steps:
      - run: echo ok
`;

const BOOL_VALUE = `name: ci
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: true
    steps:
      - run: echo ok
`;

const TOO_HIGH = `name: ci
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    steps:
      - run: echo ok
`;

const ZERO_DISABLES = `name: ci
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 0
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

test("checkWorkflowFile flags exactly the one unguarded job", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", ONE_UNGUARDED);
    const findings = checkWorkflowFile(file);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].jobId, "unguarded");
    assert.equal(findings[0].code, "no-timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags every unguarded job (no aggregation)", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", ALL_UNGUARDED);
    const findings = checkWorkflowFile(file);
    assert.equal(findings.length, 2);
    const jobIds = findings.map((f) => f.jobId).sort();
    assert.deepEqual(jobIds, ["a", "b"]);
    for (const f of findings) {
      assert.equal(f.code, "no-timeout");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags a string `'15'` value as not-int (silent failure shape)", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", STRING_VALUE);
    const findings = checkWorkflowFile(file);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].jobId, "build");
    assert.equal(findings[0].code, "not-int");
    assert.match(findings[0].message, /string/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags a boolean true value as not-int (no truthy-int sneak)", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", BOOL_VALUE);
    const findings = checkWorkflowFile(file);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].jobId, "build");
    assert.equal(findings[0].code, "not-int");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags 360 as out-of-band (the default-unbounded value)", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", TOO_HIGH);
    const findings = checkWorkflowFile(file);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].jobId, "build");
    assert.equal(findings[0].code, "out-of-band");
    assert.match(findings[0].message, /policy band/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkWorkflowFile flags 0 as out-of-band (GitHub Actions semantics: disabled)", () => {
  const { root, workflowsDir } = makeTempWorkflowsDir();
  try {
    const file = writeWorkflow(workflowsDir, "ci.yml", ZERO_DISABLES);
    const findings = checkWorkflowFile(file);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, "out-of-band");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy band constants are exposed and sensible", () => {
  assert.equal(MIN_TIMEOUT_MINUTES, 1);
  assert.equal(MAX_TIMEOUT_MINUTES, 30);
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
    writeWorkflow(workflowsDir, "ci.yml", ALL_UNGUARDED);
    const errs = [];
    const code = run({
      workflowsDir,
      log: () => {},
      err: (m) => errs.push(m),
    });
    assert.equal(code, 1);
    assert.ok(errs.some((m) => m.includes("FAIL")));
    assert.ok(errs.some((m) => m.includes("360 min/job")));
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
