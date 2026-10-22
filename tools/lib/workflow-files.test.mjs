//
// `listWorkflowFiles` and the three checkers that read through it (#325).
//
// The behavioural arms for each checker live in that checker's own test file
// (a bad `.yaml` beside a clean `.yml` must fail it). This file pins the shared
// definition itself, and pins that every checker uses it: the bug was three
// private copies of one `.yml`-only filter, so a fourth copy is the regression.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import * as concurrency from "../check-workflow-concurrency.mjs";
import * as timeout from "../check-workflow-timeout.mjs";
import * as yaml from "../check-workflow-yaml.mjs";
import { isWorkflowFileName, listWorkflowFiles } from "./workflow-files.mjs";

test("both extensions GitHub Actions runs are workflow files", () => {
  for (const name of ["ci.yml", "ci.yaml", "a.b.yml", "release.yaml"]) {
    assert.equal(isWorkflowFileName(name), true, name);
  }
});

test("names that only resemble a workflow file are not", () => {
  // The neighbours of a too-loose fix: a substring match, a missing anchor, a
  // missing dot.
  for (const name of ["notes.txt", "ci.yml.bak", "ci.yamlx", "ci.ymlx", "yml", "yaml", "ci.YML.txt", "ci.json"]) {
    assert.equal(isWorkflowFileName(name), false, name);
  }
});

test("listWorkflowFiles returns .yml and .yaml together, sorted, and [] for a missing dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-workflow-files-"));
  try {
    for (const name of ["b.yml", "a.yaml", "c.yml", "ignore.txt", "d.yml.bak"]) {
      writeFileSync(join(dir, name), "name: x\n");
    }
    assert.deepEqual(listWorkflowFiles(dir).map((p) => basename(p)), ["a.yaml", "b.yml", "c.yml"]);
    assert.deepEqual(listWorkflowFiles(join(dir, "does-not-exist")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every workflow checker lists files through the shared definition", () => {
  for (const [name, mod] of Object.entries({ concurrency, timeout, yaml })) {
    assert.equal(mod.listWorkflowFiles, listWorkflowFiles, `check-workflow-${name}`);
  }
});
