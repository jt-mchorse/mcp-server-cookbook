//
// Every `tools/` test file is registered somewhere that runs it (#170).
//
// `tools/` has no glob-based runner: each test is named explicitly in
// `package.json` and in `.github/workflows/ci.yml`. So adding a test file is
// two edits away from being a test file nobody runs — which is exactly the
// `stuck-registration` fingerprint `portfolio-ops`' Phase-A audit exists to
// surface, and #170 added a test file, so this is the arm that stops the next
// one going unregistered.
//
// This is deliberately a check on REGISTRATION, not on coverage. It says
// nothing about whether a test is good; it says the runner can see it.
//
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { stripComments } from "./lib/strip-comments.mjs";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TOOLS_DIR);

/**
 * Every file under `tools/` matching `predicate(basename)`, recursively, as a
 * repo-relative path.
 *
 * ONE walk, parameterised (#172). This file used to have two discoveries: the
 * test scan recursed -- with a comment saying exactly why, because #170 put a
 * shared helper in `tools/lib/` and "a flat `readdirSync` would not have seen
 * its test at all" -- and the checker scan fifty lines below it was a flat
 * `readdirSync(TOOLS_DIR)`. Same file, same directory, same hazard, opposite
 * treatment, with the lesson stated in prose above the place it was not applied.
 *
 * Nothing was hidden by it: `tools/lib/` holds `strip-comments.mjs`, a helper
 * rather than a checker, so every entry point was wired. It is closed anyway
 * because the precedent for putting a file in `tools/lib/` is #170 itself -- the
 * change that added this lock -- and this class has been paid for four times in
 * the portfolio (#168's one-level scan, #170's recursion,
 * nextjs-streaming-ai-patterns#122 and #123).
 *
 * Parameterised rather than copied: a second corrected recursive walk beside the
 * first is the copy-instead-of-share shape #170 fixed for `stripComments`, and a
 * suite cannot tell one definition from two identical ones. `the file has exactly
 * one directory walk` is the arm that pins it.
 */
function toolsFiles(predicate, dir = TOOLS_DIR) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...toolsFiles(predicate, abs));
      continue;
    }
    if (predicate(name)) out.push(relative(ROOT, abs).split("\\").join("/"));
  }
  return out.sort();
}

/** A `tools/` test file. */
const isTestFile = (name) => name.endsWith(".test.mjs");

/**
 * A checker: a `tools/` entry point CI is expected to run.
 *
 * The `check-` prefix is a decision, not an accident (#172). `capture-demo.mjs`
 * is deliberately outside it -- a demo recorder is not a gate, and running it in
 * CI is not what `stuck-registration` is about. Its *test* is covered by the
 * test discovery above, which is the part that can rot. `tools/lib/*.mjs` is
 * outside it for the same kind of reason: a library has no CI step of its own,
 * and its test does.
 */
const isChecker = (name) =>
  name.startsWith("check-") && name.endsWith(".mjs") && !name.endsWith(".test.mjs");

const TESTS = toolsFiles(isTestFile);
const PACKAGE_JSON = readFileSync(join(ROOT, "package.json"), "utf8");
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

test("the discovery finds the tools tests, recursively", () => {
  // Anti-vacuous, and the reason it recurses: #170 put a shared helper in
  // `tools/lib/`, and a flat `readdirSync` would not have seen its test at
  // all — which is the same one-level-scan defect #168 fixed in the string
  // grammar checker's own population.
  assert.ok(TESTS.length >= 12, `found only ${TESTS.length} tools tests: ${TESTS}`);
  assert.ok(
    TESTS.includes("tools/lib/strip-comments.test.mjs"),
    `the recursive walk missed tools/lib/: ${TESTS}`,
  );
  assert.ok(TESTS.includes("tools/check-numeric-env-grammar.test.mjs"));
});

// Deliberately NOT asserted: that every test file has an `npm run` alias.
// Measured — 6 of the 14 (`capture-demo`, `check-architecture-doc`,
// `check-claude-desktop-config`, `check-readme`, `check-spec-version`,
// `check-test-count`) have no script and are invoked directly by CI. Requiring
// one would be inventing a convention this repo does not have, and a check
// that fails on correct code is worse than no check — this repo says so in
// three separate files. CI is what gates, so CI is what is asserted.

test("every tools test file is named in ci.yml", () => {
  const missing = TESTS.filter((t) => !CI.includes(t));
  assert.deepEqual(
    missing,
    [],
    `these tools test files are not named in .github/workflows/ci.yml, so CI ` +
      `never runs them: ${missing.join(", ")}`,
  );
});

test("the registration scan would notice an unregistered file", () => {
  // Both assertions above are `deepEqual([], ...)` over a filter, which a scan
  // that read nothing would also satisfy. Prove the membership test is real by
  // running it against a name that is definitely absent.
  const invented = "tools/check-does-not-exist.test.mjs";
  assert.ok(!PACKAGE_JSON.includes(invented));
  assert.ok(!CI.includes(invented));
  // And prove a real one IS found, so the test is not passing because the two
  // files failed to load.
  assert.ok(PACKAGE_JSON.includes("tools/check-numeric-env-grammar.test.mjs"));
  assert.ok(CI.includes("tools/check-numeric-env-grammar.test.mjs"));
});

test("this file is itself registered", () => {
  // A registration check that is not registered is the shape it exists to
  // prevent.
  const self = relative(ROOT, fileURLToPath(import.meta.url)).split("\\").join("/");
  assert.ok(CI.includes(self), `${self} is not in ci.yml`);
});

test("every tools CHECKER is run by CI, not only its test", () => {
  // The arm that found something on its first run: `check-workflow-concurrency`
  // had ZERO ci.yml references while its three siblings (`check-workflow-yaml`,
  // `check-workflow-timeout`, `check-boot-config-guard`) had two or three each.
  // A checker with tests, an npm alias and no CI step is the
  // `stuck-registration` fingerprint exactly — it passes locally forever and
  // gates nothing. Wiring it is part of #170 because this assertion cannot go
  // green without it.
  // The SAME recursive walk the test discovery uses (#172). This was a flat
  // `readdirSync(TOOLS_DIR)`, fifty lines below a comment explaining why a flat
  // walk is wrong here.
  const checkers = toolsFiles(isChecker);
  assert.ok(checkers.length >= 10, `found only ${checkers.length} checkers`);
  const unwired = checkers.filter((n) => !CI.includes(n)).sort();
  assert.deepEqual(
    unwired,
    [],
    `these checkers exist and CI never runs them: ${unwired.join(", ")}`,
  );
});

test("the checker discovery is recursive, proven on a synthetic tree", () => {
  // A test over the real `tools/` CANNOT prove this: `tools/lib/` contains a
  // helper and no checker, so a flat scan and a recursive one return the same
  // list today. That is exactly why the gap survived #170 (#172). So build a
  // tree that separates them.
  const fixture = mkdtempSync(join(tmpdir(), "mcp-tools-walk-"));
  try {
    mkdirSync(join(fixture, "lib"));
    mkdirSync(join(fixture, "node_modules"));
    mkdirSync(join(fixture, ".cache"));
    writeFileSync(join(fixture, "check-flat.mjs"), "// flat checker\n");
    writeFileSync(join(fixture, "check-flat.test.mjs"), "// its test\n");
    writeFileSync(join(fixture, "lib", "check-nested.mjs"), "// NESTED checker\n");
    writeFileSync(join(fixture, "lib", "helper.mjs"), "// not a checker\n");
    writeFileSync(join(fixture, "node_modules", "check-vendored.mjs"), "// must be skipped\n");
    writeFileSync(join(fixture, ".cache", "check-hidden.mjs"), "// must be skipped\n");

    const found = toolsFiles(isChecker, fixture).map((p) => p.split("/").pop());
    assert.deepEqual(
      found.sort(),
      ["check-flat.mjs", "check-nested.mjs"],
      "the checker discovery must reach a nested checker and must skip " +
        `node_modules and dotdirs; got ${found.join(", ")}`,
    );

    // And the test predicate over the same tree, so the two populations are
    // demonstrably different rather than two names for one list.
    const tests = toolsFiles(isTestFile, fixture).map((p) => p.split("/").pop());
    assert.deepEqual(tests, ["check-flat.test.mjs"]);
    assert.notDeepEqual(found, tests, "the two predicates must select different files");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a flat walk would miss the nested checker (the defect, run)", () => {
  // The falsification, in the file rather than in a commit message: reproduce the
  // pre-#172 scan over the same synthetic tree and show it does not see the
  // nested checker. Without this, the arm above is satisfied by any walk at all.
  const fixture = mkdtempSync(join(tmpdir(), "mcp-tools-flat-"));
  try {
    mkdirSync(join(fixture, "lib"));
    writeFileSync(join(fixture, "check-flat.mjs"), "//\n");
    writeFileSync(join(fixture, "lib", "check-nested.mjs"), "//\n");
    const flat = readdirSync(fixture).filter(isChecker).sort();
    assert.deepEqual(flat, ["check-flat.mjs"], "the flat scan should see only the top level");
    const recursive = toolsFiles(isChecker, fixture).map((p) => p.split("/").pop()).sort();
    assert.deepEqual(recursive, ["check-flat.mjs", "check-nested.mjs"]);
    assert.ok(
      recursive.length > flat.length,
      "if these agree the fixture no longer separates the two walks",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("both discoveries go through the shared walk, at the call site", () => {
  // The arm that catches the DEFECT, as opposed to the function being capable.
  //
  // `the checker discovery is recursive, proven on a synthetic tree` calls
  // `toolsFiles(isChecker, fixture)` directly, so it stays GREEN when the call
  // site inside `every tools CHECKER is run by CI` is reverted to a flat
  // `readdirSync(TOOLS_DIR)` -- measured: that revert turns only the
  // readdirSync-count arm red, and only incidentally, by the count going 2 -> 3.
  // A predicate with no test of where it is CALLED is one the next edit can
  // orphan silently, which is the shape of #172 itself.
  const code = stripComments(readFileSync(fileURLToPath(import.meta.url), "utf8"));
  assert.match(
    code,
    /const checkers = toolsFiles\(isChecker\)/,
    "the checker discovery must go through the shared recursive walk",
  );
  assert.match(
    code,
    /const TESTS = toolsFiles\(isTestFile\)/,
    "the test discovery must go through the shared recursive walk",
  );
  // And no discovery may scan `tools/` one level deep. The falsification arm's
  // `readdirSync(fixture)` is over a FIXTURE, not over TOOLS_DIR, so naming
  // TOOLS_DIR here separates the two without counting call sites.
  assert.ok(
    !/readdirSync\(TOOLS_DIR\)/.test(code),
    "a flat one-level scan of TOOLS_DIR is back; that is the #172 defect. "
      + "Spelled here without the literal call, because this message is part of "
      + "the source this assertion reads -- a first draft put the pattern in the "
      + "message and the arm failed against itself.",
  );
});

test("the file has exactly one directory walk", () => {
  // One definition, not two corrected copies (#172). The defect was two
  // discoveries in one file that disagreed; a second `readdirSync`-driven walk
  // appearing here would be how they diverge again. The falsification arm above
  // uses `readdirSync` deliberately, so the count is TWO call sites and exactly
  // one of them recurses -- pinned by name rather than by count alone.
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const code = stripComments(self);
  const walks = code.match(/readdirSync\(/g) ?? [];
  assert.equal(
    walks.length,
    2,
    `expected exactly two readdirSync call sites (the shared walk and the ` +
      `flat-scan falsification arm); found ${walks.length}`,
  );
  assert.equal(
    (code.match(/function toolsFiles\(/g) ?? []).length,
    1,
    "toolsFiles must be defined exactly once",
  );
  // And the recursion must be there, not merely the function.
  assert.match(code, /toolsFiles\(predicate, abs\)/);
});
