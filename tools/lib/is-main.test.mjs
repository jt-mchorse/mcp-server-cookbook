//
// `isMain` and its fifteen call sites (#245).
//
// The behavioural arms spawn a real checker through the two path shapes that
// made every inline guard false -- a symlinked checkout and a directory whose
// name has a space -- with an input the checker must reject. A false guard
// exits 0 with no output, so "it exited non-zero and said why" is the only
// observable that separates a gate that ran from one that did not.
//
// The CI runner's own path has neither shape, so these arms build both
// explicitly rather than relying on the host (macOS `/tmp` happens to be a
// symlink; Linux's is not).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { isMain } from "./is-main.mjs";
import { stripComments } from "./strip-comments.mjs";
import { REPO_ROOT, TOOLS_DIR, isModule, isTestFile, toolsFiles } from "./tools-files.mjs";

const work = mkdtempSync(join(tmpdir(), "is-main-"));
after(() => rmSync(work, { recursive: true, force: true }));

// A vitest report that disagrees with every entry in tools/test-counts.json.
const badReport = join(work, "report.json");
writeFileSync(badReport, JSON.stringify({ numPassedTests: 0 }));

function runTestCount(script) {
  return spawnSync(process.execPath, [script, "github-gists", badReport], { encoding: "utf8" });
}

test("a checker run through a symlinked checkout still runs (#245)", () => {
  const link = join(work, "link");
  symlinkSync(REPO_ROOT, link, "dir");
  const r = runTestCount(join(link, "tools", "check-test-count.mjs"));
  assert.equal(r.status, 1, `expected the drift exit, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /github-gists ran 0 test case\(s\)/);
});

test("a checker run from a directory whose name has a space still runs (#245)", () => {
  // A real directory, not a symlink, so this arm isolates the URL-encoding half.
  const spaced = join(realpathSync(work), "with space");
  mkdirSync(spaced);
  cpSync(TOOLS_DIR, join(spaced, "tools"), {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  const r = runTestCount(join(spaced, "tools", "check-test-count.mjs"));
  assert.equal(r.status, 1, `expected the drift exit, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /github-gists ran 0 test case\(s\)/);
});

test("isMain: true for the module's own path, directly or through a symlink", () => {
  const target = join(realpathSync(work), "mod.mjs");
  writeFileSync(target, "");
  const url = pathToFileURL(target).href;
  assert.equal(isMain(url, target), true);
  const alias = join(work, "alias.mjs");
  symlinkSync(target, alias);
  assert.equal(isMain(url, alias), true);
  assert.equal(isMain(pathToFileURL(alias).href, target), true);
});

test("isMain: false, never a throw, for another file, a missing path, or no argv[1]", () => {
  const url = pathToFileURL(join(TOOLS_DIR, "check-readme.mjs")).href;
  assert.equal(isMain(url, join(TOOLS_DIR, "check-test-count.mjs")), false);
  assert.equal(isMain(url, join(work, "does-not-exist.mjs")), false);
  assert.equal(isMain(url, undefined), false);
  assert.equal(isMain(url, ""), false);
});

test("no tools/ module decides direct invocation by itself; every entry point uses isMain", () => {
  // Exempted by exact path, not by name fragment (D-012).
  const CANONICAL = "tools/lib/is-main.mjs";
  const modules = toolsFiles((n) => isModule(n) && !isTestFile(n));
  assert.ok(modules.includes(CANONICAL), "the walk must reach tools/lib/");
  const offenders = [];
  const entryPoints = [];
  for (const rel of modules) {
    if (rel === CANONICAL) continue;
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    if (/process\.argv\[1\]/.test(src)) offenders.push(rel);
    if (/\bif \(isMain\(import\.meta\.url\)\)/.test(src)) entryPoints.push(rel);
  }
  assert.deepEqual(offenders, [], "compare paths through isMain, not argv[1] directly");
  // The fifteen scripts that had an inline guard on main (e03ea0f).
  assert.equal(entryPoints.length, 15, `entry points using isMain: ${entryPoints.join(", ")}`);
});

// --- #317: the same spaced-path shape, in a test's own path resolution ------
//
// `check-workflow-yaml.test.mjs` located the repo's `.github/workflows/` with
// `new URL(import.meta.url).pathname`, which keeps a space as `%20`. Under a
// spaced checkout the directory "did not exist" and the test returned early
// as a pass, so a broken workflow went unreported by the one test that reads
// the real ones. These arms run that test in a temp checkout, filtered to the
// one case by name, and read its exit status.

const WORKFLOW_TEST = "tools/check-workflow-yaml.test.mjs";
const REAL_CASE = "run is clean against the real .github/workflows/ directory";
const REAL_CASE_RE = REAL_CASE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// The case's own TAP line, which is how these arms know it RAN: Node 20 counts
// pattern-filtered cases in `# tests` (as skips), so the summary cannot say.
const ranAndFailed = new RegExp(`^not ok \\d+ - ${REAL_CASE_RE}$`, "m");
const ranAndPassed = new RegExp(`^ok \\d+ - ${REAL_CASE_RE}$`, "m");

function runRealWorkflowsCase(root, workflows) {
  cpSync(TOOLS_DIR, join(root, "tools"), {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  // The checker imports `yaml`; resolve it from the real checkout.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
  if (workflows) {
    const wf = join(root, ".github", "workflows");
    mkdirSync(wf, { recursive: true });
    for (const [name, body] of Object.entries(workflows)) writeFileSync(join(wf, name), body);
  }
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  return spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", `--test-name-pattern=^${REAL_CASE_RE}$`, WORKFLOW_TEST],
    // TAP so the case line can be matched; NODE_TEST_CONTEXT removed so the child reports
    // to its own stdout instead of streaming into this runner.
    { cwd: root, encoding: "utf8", env },
  );
}

const CLEAN_WORKFLOW = "name: ok\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";

test("the real-workflows case fails on a broken workflow in a checkout whose path has a space (#317)", () => {
  const root = join(realpathSync(work), "sp ace 317 broken");
  mkdirSync(root);
  const r = runRealWorkflowsCase(root, { "ci.yml": CLEAN_WORKFLOW, "zz-broken.yml": "name: x\non: [push\njobs: {\n" });
  assert.notEqual(r.status, 0, `a broken workflow must fail the case; stdout=${r.stdout}`);
  assert.match(r.stdout, ranAndFailed);
  // ...because of the broken file, not because the directory was not found.
  assert.match(r.stdout, /real \.github\/workflows\/ should be clean/);
});

test("the real-workflows case fails, rather than skipping, when the workflows directory is missing (#317)", () => {
  const root = join(realpathSync(work), "no-workflows-317");
  mkdirSync(root);
  const r = runRealWorkflowsCase(root, null);
  assert.notEqual(r.status, 0, `a missing workflows dir must fail the case; stdout=${r.stdout}`);
  assert.match(r.stdout, ranAndFailed);
  assert.match(r.stdout, /real workflows directory not found/);
});

test("control: the real-workflows case passes on clean workflows in a spaced checkout (#317)", () => {
  // Green before and after the fix: it is what shows the broken-workflow arm
  // fails because of the broken file, not because the spaced copy cannot run.
  const root = join(realpathSync(work), "sp ace 317 clean");
  mkdirSync(root);
  const r = runRealWorkflowsCase(root, { "ci.yml": CLEAN_WORKFLOW });
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, ranAndPassed);
});

test("no tools/ or servers/ source turns import.meta.url into a path via .pathname (#317)", () => {
  // `fileURLToPath` decodes `%20`; `.pathname` does not. The sweep for #317
  // found one such site, so this arm stops the second rather than fixing one.
  const PATHNAME = /import\.meta\.url\s*\)\s*\.pathname/;
  const files = toolsFiles(isModule);
  const serverRoot = join(REPO_ROOT, "servers");
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.(?:[cm]?js|ts)$/.test(name)) files.push(relative(REPO_ROOT, abs).split("\\").join("/"));
    }
  };
  walk(serverRoot);
  // Anti-vacuous: the walk reaches the file #317 was in, and the server tests.
  assert.ok(files.includes(WORKFLOW_TEST), `walk missed ${WORKFLOW_TEST}`);
  assert.ok(
    files.includes("servers/filesystem-sandbox/test/content-parity.test.ts"),
    "walk missed servers/*/test",
  );
  // Comments stripped: this file's own header names the shape it forbids.
  const offenders = files.filter((rel) =>
    PATHNAME.test(stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"))),
  );
  assert.deepEqual(offenders, [], "use fileURLToPath(import.meta.url), not .pathname");
});
