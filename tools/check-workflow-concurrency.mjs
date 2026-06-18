#!/usr/bin/env node
//
// Verify every .github/workflows/*.yml in this repo has a top-level
// `concurrency:` block with a non-empty string `group` and
// `cancel-in-progress: true`.
//
// Companion to tools/check-workflow-yaml.mjs and
// tools/check-workflow-timeout.mjs — same silent-rot prevention arc,
// different failure mode.
//
// The failure mode this catches: without a `concurrency:` group, a
// rapid push-on-push (rebased session branch force-pushed, PR chain
// merged in quick succession, contributor amending mid-flight) burns
// one full CI run per push even though the in-flight run is
// immediately superseded.
//
// Exit codes (matching the other check tools in this dir):
//   0 — every workflow file has a sensible concurrency block
//   1 — one or more findings; details printed to stderr
//   2 — bad input (no workflows directory, or filesystem error)
//
// Sister implementations in the silent-rot concurrency arc:
//   - llm-eval-harness/tests/test_workflows_concurrency.py (#64, Python canonical)
//   - rag-production-kit (#56), chunking-strategies-lab (#43),
//     embedding-model-shootout (#53), vector-search-at-scale (#45),
//     python-async-llm-pipelines (#52), prompt-regression-suite (#57),
//     llm-cost-optimizer (#60) — Python pytest
//   - nextjs-streaming-ai-patterns (#38, first TS), agent-orchestration-platform (#45, TS)
//   - portfolio-ops/scripts/audit_phase_a.py --check missing-concurrency (#41,
//     post-deploy fingerprint that surfaces unprotected repos weekly)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as yamlParse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

/** List every workflow YAML file under `workflowsDir` (lex-sorted absolutes). */
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
 * Check a single workflow file. Returns an array of findings (empty if
 * clean). Each finding is `{ code, message }` where `code` is one of:
 *   - "parse"       — yaml.parse threw (delegate to check-workflow-yaml.mjs)
 *   - "shape"       — top-level isn't a mapping (delegate)
 *   - "no-concurrency"          — workflow has no top-level concurrency key
 *   - "concurrency-not-mapping" — concurrency is set but isn't a mapping
 *   - "no-group"                — concurrency.group missing
 *   - "group-not-string"        — group is set but not a string
 *   - "group-empty"             — group is an empty/whitespace string
 *   - "no-cancel"               — concurrency.cancel-in-progress missing
 *   - "cancel-not-bool"         — cancel-in-progress not a boolean
 *   - "cancel-not-true"         — cancel-in-progress is `false`
 */
export function checkWorkflowFile(filePath, fileReader = readFileSync) {
  const text = fileReader(filePath, "utf-8");
  let parsed;
  try {
    parsed = yamlParse(text);
  } catch (exc) {
    return [{ code: "parse", message: `failed yaml.parse: ${String(exc)}` }];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [
      {
        code: "shape",
        message: `top-level is ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}, expected mapping`,
      },
    ];
  }
  const concurrency = parsed.concurrency;
  if (concurrency === undefined) {
    return [
      {
        code: "no-concurrency",
        message:
          "no top-level `concurrency:` block. Without one, a rapid " +
          "push-on-push burns one full CI run per push even when the " +
          "in-flight run is immediately superseded. Add " +
          "`concurrency: { group: 'ci-${{ github.ref }}', " +
          "cancel-in-progress: true }`.",
      },
    ];
  }
  if (
    concurrency === null ||
    typeof concurrency !== "object" ||
    Array.isArray(concurrency)
  ) {
    return [
      {
        code: "concurrency-not-mapping",
        message: `concurrency: is a ${concurrency === null ? "null" : Array.isArray(concurrency) ? "array" : typeof concurrency}, expected mapping`,
      },
    ];
  }
  const findings = [];
  const group = concurrency.group;
  if (group === undefined) {
    findings.push({
      code: "no-group",
      message:
        "concurrency.group is missing. GitHub Actions requires a group " +
        "key to dedupe runs; absence falls back to a default that doesn't " +
        "dedupe — silently reintroducing the failure mode this check exists " +
        "to prevent.",
    });
  } else if (typeof group !== "string") {
    findings.push({
      code: "group-not-string",
      message: `concurrency.group is ${typeof group}, expected string`,
    });
  } else if (group.trim().length === 0) {
    findings.push({
      code: "group-empty",
      message: `concurrency.group is empty/whitespace ${JSON.stringify(group)}`,
    });
  }
  const cancel = concurrency["cancel-in-progress"];
  if (cancel === undefined) {
    findings.push({
      code: "no-cancel",
      message:
        "concurrency.cancel-in-progress is missing. Without it, GitHub " +
        "Actions defaults to queueing rather than cancelling — the prior " +
        "run completes, burning the quota this check exists to save. Set " +
        "`cancel-in-progress: true`.",
    });
  } else if (typeof cancel !== "boolean") {
    findings.push({
      code: "cancel-not-bool",
      message:
        `concurrency.cancel-in-progress is ${JSON.stringify(cancel)} ` +
        `(${typeof cancel}); must be the YAML bool \`true\`. A string ` +
        "`'true'` produces inverse semantics under some GitHub Actions paths.",
    });
  } else if (cancel !== true) {
    findings.push({
      code: "cancel-not-true",
      message:
        "concurrency.cancel-in-progress is `false`; that defeats the lock's " +
        "purpose — the prior run completes, burning the quota the lock " +
        "exists to save.",
    });
  }
  return findings;
}

const SILENT_QUOTA_BURN_HINT =
  "Without a concurrency group, a rapid push-on-push burns one full CI " +
  "run per push even when the in-flight run is immediately superseded. " +
  "Fix the workflow, do not skip this check.";

/** Top-level runner: returns the exit code (0 / 1 / 2). */
export function run({
  workflowsDir = WORKFLOWS_DIR,
  log = console.log,
  err = console.error,
} = {}) {
  if (!existsSync(workflowsDir)) {
    err(`check-workflow-concurrency: ${workflowsDir} does not exist`);
    return 2;
  }
  const files = listWorkflowFiles(workflowsDir);
  if (files.length === 0) {
    err(`check-workflow-concurrency: no *.yml files found under ${workflowsDir}`);
    return 2;
  }
  let findingCount = 0;
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const findings = checkWorkflowFile(file);
    if (findings.length === 0) {
      log(`ok ${rel}`);
      continue;
    }
    for (const f of findings) {
      findingCount += 1;
      err(`FAIL ${rel} [${f.code}]: ${f.message}`);
    }
  }
  if (findingCount > 0) {
    err(`check-workflow-concurrency: ${findingCount} finding(s) across ${files.length} file(s).`);
    err(SILENT_QUOTA_BURN_HINT);
    return 1;
  }
  log(`check-workflow-concurrency: ${files.length} workflow file(s) clean.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
