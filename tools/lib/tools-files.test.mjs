//
// The shared `tools/` walk (#174).
//
// `tools/lib/*.mjs` is outside the registration lock's `isChecker` — "a library
// has no CI step of its own, and its test does" — so this file is the thing CI
// runs for the module, and the registration lock requires it to be named in
// `ci.yml`.
//

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  REPO_ROOT,
  TOOLS_DIR,
  isModule,
  isTestFile,
  toolsFiles,
} from "./tools-files.mjs";

test("the walk recurses, proven on a synthetic tree", () => {
  // A fixture rather than the real tree, so the property is about the WALK and
  // not about today's directory layout. The arms in
  // `strip-comments.test.mjs` cover the real tree; this one covers the function.
  const fixture = mkdtempSync(join(tmpdir(), "mcp-tools-files-"));
  try {
    mkdirSync(join(fixture, "nested", "deeper"), { recursive: true });
    writeFileSync(join(fixture, "top.mjs"), "//\n");
    writeFileSync(join(fixture, "nested", "mid.mjs"), "//\n");
    writeFileSync(join(fixture, "nested", "deeper", "leaf.mjs"), "//\n");
    writeFileSync(join(fixture, "ignored.txt"), "//\n");
    const found = toolsFiles(isModule, fixture).map((p) => p.split("/").pop());
    assert.deepEqual(found, ["leaf.mjs", "mid.mjs", "top.mjs"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("node_modules and dotfiles are skipped", () => {
  // Both would otherwise make the walk enormous and non-deterministic. Pinned
  // because "it is fast today" is not a property.
  const fixture = mkdtempSync(join(tmpdir(), "mcp-tools-files-skip-"));
  try {
    mkdirSync(join(fixture, "node_modules"));
    mkdirSync(join(fixture, ".hidden"));
    writeFileSync(join(fixture, "node_modules", "dep.mjs"), "//\n");
    writeFileSync(join(fixture, ".hidden", "secret.mjs"), "//\n");
    writeFileSync(join(fixture, ".dotfile.mjs"), "//\n");
    writeFileSync(join(fixture, "real.mjs"), "//\n");
    assert.deepEqual(
      toolsFiles(isModule, fixture).map((p) => p.split("/").pop()),
      ["real.mjs"],
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the predicate sees a basename, not a path", () => {
  // `isChecker` in the registration lock tests `name.startsWith("check-")`, so
  // a predicate handed a repo-relative path would match nothing under
  // `tools/lib/` and silently shrink that lock's population — which is the
  // class #174 is about, reintroduced through the parameter.
  const fixture = mkdtempSync(join(tmpdir(), "mcp-tools-files-pred-"));
  try {
    mkdirSync(join(fixture, "lib"));
    writeFileSync(join(fixture, "lib", "check-nested.mjs"), "//\n");
    const seen = [];
    toolsFiles((name) => {
      seen.push(name);
      return false;
    }, fixture);
    assert.deepEqual(seen, ["check-nested.mjs"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("paths are repo-relative, POSIX, and sorted", () => {
  const found = toolsFiles(isTestFile);
  assert.ok(found.length >= 12, `found only ${found.length} tools tests`);
  for (const rel of found) {
    assert.ok(rel.startsWith("tools/"), `${rel} is not repo-relative`);
    assert.ok(!rel.includes("\\"), `${rel} is not POSIX`);
  }
  assert.deepEqual(
    found,
    [...found].sort(),
    "the walk must return a stable order",
  );
});

test("the real walk reaches tools/lib/", () => {
  // The anti-vacuity that matters for this module: every issue in this class
  // (#168, #170, #172, #173, #174) was a walk that did not reach this
  // directory, and this module exists so there is one place to assert it does.
  const modules = toolsFiles(isModule);
  assert.ok(modules.includes("tools/lib/tools-files.mjs"));
  assert.ok(modules.includes("tools/lib/strip-comments.mjs"));
});

test("TOOLS_DIR and REPO_ROOT resolve from this module, not from the caller", () => {
  // Derived from `import.meta.url` so a checker invoked from any working
  // directory gets the same population. A `process.cwd()`-based root is the
  // usual way this breaks.
  assert.ok(
    TOOLS_DIR.endsWith("/tools") || TOOLS_DIR.endsWith("\\tools"),
    TOOLS_DIR,
  );
  assert.equal(join(REPO_ROOT, "tools"), TOOLS_DIR);
});
