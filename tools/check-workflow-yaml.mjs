#!/usr/bin/env node
//
// Verify every .github/workflows/*.yml in this repo parses cleanly and
// has a non-empty `jobs:` mapping.
//
// This is the inverse safety net for the 21-day silent CI outage closed
// in portfolio-ops#27 / portfolio-ops#28. A single unquoted colon-space
// in a `run:` value made one workflow unparseable; GitHub Actions'
// lenient parser still *completed* the run with zero jobs and
// `conclusion=failure`, and `statusCheckRollup` stayed empty so Phase
// A auto-merge couldn't tell that no CI ran.
//
// The check is dual-shape:
//   1. yaml.parse must succeed.
//   2. `jobs:` must be a non-empty mapping (catches the broader "valid
//      YAML, no actual workflow" failure mode in case GitHub Actions
//      silently absorbs another shape the same way).
//
// Exit codes:
//   0 — all workflow files clean
//   1 — one or more findings; details printed to stderr
//   2 — bad input (no workflows directory, or filesystem error)
//
// Sister implementations:
//   - portfolio-ops/tests/test_workflows_yaml_parseable.py
//   - llm-eval-harness/tests/test_workflows_yaml_parseable.py (#60)
//   - agent-orchestration-platform/test/workflows-yaml-parseable.test.ts (#41)
//   - (Python sisters across rag-production-kit, chunking-strategies-lab,
//      llm-cost-optimizer, prompt-regression-suite, embedding-model-shootout,
//      vector-search-at-scale, python-async-llm-pipelines)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as yamlParse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

/**
 * List every workflow YAML file under `workflowsDir`. Returns absolute
 * paths sorted lexicographically so output is deterministic.
 */
export function listWorkflowFiles(workflowsDir) {
  if (!existsSync(workflowsDir)) {
    return [];
  }
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => path.join(workflowsDir, name));
}

/**
 * Check a single workflow file. Returns `{ ok: true }` on success or
 * `{ ok: false, code, message }` on failure.
 *
 * `code` is one of:
 *   - "parse"    — yaml.parse threw
 *   - "shape"    — top-level isn't a mapping
 *   - "no-jobs"  — `jobs:` missing or not a mapping
 *   - "empty-jobs" — `jobs:` mapping has zero entries
 */
export function checkWorkflowFile(filePath, fileReader = readFileSync) {
  const text = fileReader(filePath, "utf-8");
  let parsed;
  try {
    parsed = yamlParse(text);
  } catch (exc) {
    return {
      ok: false,
      code: "parse",
      message: `failed yaml.parse: ${String(exc)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "shape",
      message: `top-level is ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}, expected mapping`,
    };
  }
  const jobs = parsed.jobs;
  if (jobs === undefined || jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
    return {
      ok: false,
      code: "no-jobs",
      message: `jobs: is ${jobs === undefined ? "missing" : Array.isArray(jobs) ? "an array" : `a ${typeof jobs}`}, expected mapping`,
    };
  }
  if (Object.keys(jobs).length === 0) {
    return {
      ok: false,
      code: "empty-jobs",
      message: "jobs: mapping is empty",
    };
  }
  return { ok: true };
}

const SILENT_CI_HINT =
  "GitHub Actions' parser is lenient enough to *complete* a workflow " +
  "with an unparseable or jobless file, emitting zero jobs and " +
  "`conclusion=failure` with an empty `statusCheckRollup` — the exact " +
  "silent-CI shape that blocked portfolio-ops for 21 days (#27). Fix " +
  "the YAML, do not skip this check.";

/**
 * Top-level runner: returns the exit code (0 / 1 / 2).
 */
export function run({ workflowsDir = WORKFLOWS_DIR, log = console.log, err = console.error } = {}) {
  if (!existsSync(workflowsDir)) {
    err(`check-workflow-yaml: ${workflowsDir} does not exist`);
    return 2;
  }
  const files = listWorkflowFiles(workflowsDir);
  if (files.length === 0) {
    err(`check-workflow-yaml: no *.yml files found under ${workflowsDir}`);
    return 2;
  }
  let findingCount = 0;
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const result = checkWorkflowFile(file);
    if (result.ok) {
      log(`ok ${rel}`);
    } else {
      findingCount += 1;
      err(`FAIL ${rel} [${result.code}]: ${result.message}`);
    }
  }
  if (findingCount > 0) {
    err(`check-workflow-yaml: ${findingCount} finding(s) across ${files.length} file(s).`);
    err(SILENT_CI_HINT);
    return 1;
  }
  log(`check-workflow-yaml: ${files.length} workflow file(s) clean.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
