//
// The workflow files the three workflow checkers read, in one place (#325).
//
// check-workflow-yaml, check-workflow-timeout and check-workflow-concurrency
// each carried their own copy of `listWorkflowFiles`, and each copy filtered on
// `name.endsWith(".yml")`. GitHub Actions runs `.yaml` files too, so a workflow
// named `rogue.yaml` with an unbounded job, or a `broken.yaml` that does not
// parse, was invisible to all three: measured on 644d772, each exited 0 with
// "1 workflow file(s) clean." beside a `ci.yml`, and the same rogue job renamed
// to `.yml` failed the timeout check. Three copies of one filter is how the
// same miss landed three times; one definition is what keeps a fix from
// reaching only some of them.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Both extensions GitHub Actions reads from `.github/workflows/`. */
export const WORKFLOW_FILE_RE = /\.ya?ml$/;

/** Whether a basename is a workflow file GitHub Actions would run. */
export const isWorkflowFileName = (name) => WORKFLOW_FILE_RE.test(name);

/**
 * List every workflow YAML file (`*.yml` and `*.yaml`) under `workflowsDir`.
 * Returns absolute paths sorted lexicographically so output is deterministic,
 * or `[]` when the directory does not exist.
 */
export function listWorkflowFiles(workflowsDir) {
  if (!existsSync(workflowsDir)) {
    return [];
  }
  return readdirSync(workflowsDir)
    .filter(isWorkflowFileName)
    .sort()
    .map((name) => path.join(workflowsDir, name));
}
