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
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { isMain } from "./is-main.mjs";
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
