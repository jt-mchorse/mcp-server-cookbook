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
// The shared recursive walk, moved to `tools/lib/` by #174 so a THIRD file
// could use it without a third copy. #172 parameterised it and #173 fixed the
// second call site; both lived here, privately, which is why
// `tools/lib/strip-comments.test.mjs` went on scanning `tools/` one level deep
// for two more issues. `isChecker` stays local: it is this lock's definition of
// a CI entry point, not a property of the filesystem.
import {
  REPO_ROOT as ROOT,
  TOOLS_DIR,
  isModule,
  isTestFile,
  toolsFiles,
} from "./lib/tools-files.mjs";

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
  name.startsWith("check-") &&
  name.endsWith(".mjs") &&
  !name.endsWith(".test.mjs");

const TESTS = toolsFiles(isTestFile);
const PACKAGE_JSON = readFileSync(join(ROOT, "package.json"), "utf8");
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

test("the discovery finds the tools tests, recursively", () => {
  // Anti-vacuous, and the reason it recurses: #170 put a shared helper in
  // `tools/lib/`, and a flat `readdirSync` would not have seen its test at
  // all — which is the same one-level-scan defect #168 fixed in the string
  // grammar checker's own population.
  assert.ok(
    TESTS.length >= 12,
    `found only ${TESTS.length} tools tests: ${TESTS}`,
  );
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
  const self = relative(ROOT, fileURLToPath(import.meta.url))
    .split("\\")
    .join("/");
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
    writeFileSync(
      join(fixture, "lib", "check-nested.mjs"),
      "// NESTED checker\n",
    );
    writeFileSync(join(fixture, "lib", "helper.mjs"), "// not a checker\n");
    writeFileSync(
      join(fixture, "node_modules", "check-vendored.mjs"),
      "// must be skipped\n",
    );
    writeFileSync(
      join(fixture, ".cache", "check-hidden.mjs"),
      "// must be skipped\n",
    );

    const found = toolsFiles(isChecker, fixture).map((p) => p.split("/").pop());
    assert.deepEqual(
      found.sort(),
      ["check-flat.mjs", "check-nested.mjs"],
      "the checker discovery must reach a nested checker and must skip " +
        `node_modules and dotdirs; got ${found.join(", ")}`,
    );

    // And the test predicate over the same tree, so the two populations are
    // demonstrably different rather than two names for one list.
    const tests = toolsFiles(isTestFile, fixture).map((p) =>
      p.split("/").pop(),
    );
    assert.deepEqual(tests, ["check-flat.test.mjs"]);
    assert.notDeepEqual(
      found,
      tests,
      "the two predicates must select different files",
    );
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
    assert.deepEqual(
      flat,
      ["check-flat.mjs"],
      "the flat scan should see only the top level",
    );
    const recursive = toolsFiles(isChecker, fixture)
      .map((p) => p.split("/").pop())
      .sort();
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
  const code = stripComments(
    readFileSync(fileURLToPath(import.meta.url), "utf8"),
  );
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
    "a flat one-level scan of TOOLS_DIR is back; that is the #172 defect. " +
      "Spelled here without the literal call, because this message is part of " +
      "the source this assertion reads -- a first draft put the pattern in the " +
      "message and the arm failed against itself.",
  );
});

test("this file defines no directory walk of its own", () => {
  // One definition, not two corrected copies (#172) -- and since #174 that one
  // definition lives in `tools/lib/tools-files.mjs`, because a THIRD file
  // needed it. What this arm pins has therefore inverted: the walk must be
  // absent here, not present-exactly-once.
  //
  // The falsification arm above still calls `readdirSync` deliberately, over a
  // FIXTURE, so the count is ONE. Naming what the single remaining call is for
  // keeps the number from being a bare magic constant the next edit re-fits.
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const code = stripComments(self);
  const walks = code.match(/readdirSync\(/g) ?? [];
  assert.equal(
    walks.length,
    1,
    `expected exactly one readdirSync call site (the flat-scan falsification ` +
      `arm, over a temp fixture); found ${walks.length}`,
  );
  assert.equal(
    (code.match(/function toolsFiles\(/g) ?? []).length,
    0,
    "toolsFiles must be imported from tools/lib/tools-files.mjs, not redefined here",
  );
  assert.match(
    code,
    /from "\.\/lib\/tools-files\.mjs"/,
    "the shared walk must be imported rather than re-pasted",
  );
});

test("the shared walk module is the only definition in the repo", () => {
  // The cross-file half, and the reason #174 exists: #172 and #173 both pinned
  // "one definition" *within this file*, and `tools/lib/strip-comments.test.mjs`
  // went on scanning `tools/` one level deep for two more issues because nothing
  // asked the question across files.
  //
  // Same shape as `no tool declares its own stripComments` one directory down,
  // and for the same reason #170 gives: two identical copies agree by
  // construction, so only a structural arm catches the next re-paste.
  const offenders = [];
  for (const rel of toolsFiles(isModule)) {
    if (rel === "tools/lib/tools-files.mjs") continue; // the definition itself
    const text = stripComments(readFileSync(join(ROOT, rel), "utf8"));
    if (/^\s*(export\s+)?function toolsFiles\b/m.test(text))
      offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files declare their own tools walk instead of importing ` +
      `tools/lib/tools-files.mjs: ${offenders.join(", ")}`,
  );
  // Anti-vacuity: the scan must reach `tools/lib/`, which is the directory every
  // one of #168/#170/#172/#173/#174 was about.
  const corpus = toolsFiles(isModule);
  assert.ok(
    corpus.length >= 25,
    `the module scan found only ${corpus.length} files`,
  );
  assert.ok(
    corpus.includes("tools/lib/tools-files.mjs"),
    `the walk did not reach tools/lib/: ${corpus}`,
  );
});
