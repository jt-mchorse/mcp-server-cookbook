#!/usr/bin/env node
//
// Verify every job in every .github/workflows/*.yml in this repo has a
// `timeout-minutes` set to an integer in the policy band [1, 30].
//
// Companion to tools/check-workflow-yaml.mjs (#46) — same silent-rot
// prevention arc, different failure mode.
//
// The failure mode this catches: GitHub Actions defaults to 360 minutes
// (6 hours) per job when no `timeout-minutes` is set. A hung job —
// `npm ci` stall, infinite typecheck loop, stuck spec-version check —
// burns the full 6-hour ceiling before the runner kills it. That's
// quota the operator pays for whether the run produced anything or not.
//
// Exit codes (matching tools/check-workflow-yaml.mjs):
//   0 — every job in every workflow file is bounded inside [1, 30]
//   1 — one or more findings; details printed to stderr
//   2 — bad input (no workflows directory, or filesystem error)
//
// Sister implementations in the silent-rot timeout-minutes arc:
//   - llm-eval-harness/tests/test_workflows_timeout_minutes.py (#63, canonical)
//   - rag-production-kit (#55), chunking-strategies-lab (#42),
//     embedding-model-shootout (#52), vector-search-at-scale (#44),
//     python-async-llm-pipelines (#51) — Python pytest
//   - nextjs-streaming-ai-patterns (#37, TS), agent-orchestration-platform (#44, TS)
//   - portfolio-ops/scripts/audit_phase_a.py --check missing-timeout (#36,
//     post-deploy fingerprint that surfaces unprotected repos weekly)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as yamlParse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

// Policy band for this repo. Tight enough that an accidental
// `timeout-minutes: 360` reverts most of the unbounded-job quota burn;
// wide enough for the per-server jobs that do `npm ci` + lint + typecheck
// + test + build (each in <3 min today). Bumping the ceiling is intentional
// and should land with a comment naming the workload that forced it.
export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 30;

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
 * clean). Each finding is `{ jobId, code, message }` where `code` is one
 * of:
 *   - "parse"     — yaml.parse threw (delegate to check-workflow-yaml.mjs)
 *   - "shape"     — top-level isn't a mapping (delegate)
 *   - "no-jobs"   — jobs: missing or not a mapping (delegate)
 *   - "no-timeout" — job has no `timeout-minutes` key
 *   - "not-int"   — value is not an integer (string, bool, float, etc.)
 *   - "out-of-band" — value is outside [MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES]
 */
export function checkWorkflowFile(filePath, fileReader = readFileSync) {
  const text = fileReader(filePath, "utf-8");
  let parsed;
  try {
    parsed = yamlParse(text);
  } catch (exc) {
    return [
      { jobId: null, code: "parse", message: `failed yaml.parse: ${String(exc)}` },
    ];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [
      {
        jobId: null,
        code: "shape",
        message: `top-level is ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}, expected mapping`,
      },
    ];
  }
  const jobs = parsed.jobs;
  if (jobs === undefined || jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
    return [
      {
        jobId: null,
        code: "no-jobs",
        message: `jobs: is ${jobs === undefined ? "missing" : Array.isArray(jobs) ? "an array" : `a ${typeof jobs}`}, expected mapping`,
      },
    ];
  }
  const findings = [];
  for (const [jobId, body] of Object.entries(jobs)) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      // Not a job mapping — skip silently. check-workflow-yaml handles
      // the broader shape lock; this checker is strictly about
      // timeout-minutes on real job bodies.
      continue;
    }
    const timeout = body["timeout-minutes"];
    if (timeout === undefined) {
      findings.push({
        jobId,
        code: "no-timeout",
        message:
          "no `timeout-minutes` set; GitHub Actions defaults to 360 min/job " +
          "and a hung job burns the full ceiling before the runner kills it. " +
          `Set timeout-minutes in [${MIN_TIMEOUT_MINUTES}, ${MAX_TIMEOUT_MINUTES}].`,
      });
      continue;
    }
    // `bool` is a subclass of nothing in JS, but a YAML `true` parses to
    // the JS boolean `true`. Reject it explicitly so a stray
    // `timeout-minutes: true` doesn't sneak past as a "truthy value".
    const isInt =
      typeof timeout === "number" && Number.isInteger(timeout) && typeof timeout !== "boolean";
    if (!isInt) {
      findings.push({
        jobId,
        code: "not-int",
        message: `timeout-minutes: ${JSON.stringify(timeout)} (${typeof timeout}); GitHub Actions requires an integer.`,
      });
      continue;
    }
    if (timeout < MIN_TIMEOUT_MINUTES || timeout > MAX_TIMEOUT_MINUTES) {
      findings.push({
        jobId,
        code: "out-of-band",
        message:
          `timeout-minutes: ${timeout} outside policy band ` +
          `[${MIN_TIMEOUT_MINUTES}, ${MAX_TIMEOUT_MINUTES}]. ` +
          "Values above the ceiling reintroduce unbounded quota burn; " +
          "values at 0 disable the timeout entirely.",
      });
    }
  }
  return findings;
}

const SILENT_QUOTA_BURN_HINT =
  "GitHub Actions defaults to 360 min/job when no `timeout-minutes` is set. " +
  "A hung job burns the full 6-hour ceiling before the runner kills it, on " +
  "the operator's quota. Fix the workflow, do not skip this check.";

/** Top-level runner: returns the exit code (0 / 1 / 2). */
export function run({
  workflowsDir = WORKFLOWS_DIR,
  log = console.log,
  err = console.error,
} = {}) {
  if (!existsSync(workflowsDir)) {
    err(`check-workflow-timeout: ${workflowsDir} does not exist`);
    return 2;
  }
  const files = listWorkflowFiles(workflowsDir);
  if (files.length === 0) {
    err(`check-workflow-timeout: no *.yml files found under ${workflowsDir}`);
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
      const where = f.jobId === null ? rel : `${rel}::${f.jobId}`;
      err(`FAIL ${where} [${f.code}]: ${f.message}`);
    }
  }
  if (findingCount > 0) {
    err(`check-workflow-timeout: ${findingCount} finding(s) across ${files.length} file(s).`);
    err(SILENT_QUOTA_BURN_HINT);
    return 1;
  }
  log(`check-workflow-timeout: ${files.length} workflow file(s) clean.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
