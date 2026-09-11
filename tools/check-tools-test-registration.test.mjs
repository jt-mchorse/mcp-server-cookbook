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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TOOLS_DIR);

/** Every `*.test.mjs` under `tools/`, recursively, as a repo-relative path. */
function toolsTestFiles(dir = TOOLS_DIR) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...toolsTestFiles(abs));
      continue;
    }
    if (name.endsWith(".test.mjs")) out.push(relative(ROOT, abs).split("\\").join("/"));
  }
  return out.sort();
}

const TESTS = toolsTestFiles();
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
  const checkers = readdirSync(TOOLS_DIR).filter(
    (n) => n.startsWith("check-") && n.endsWith(".mjs") && !n.endsWith(".test.mjs"),
  );
  assert.ok(checkers.length >= 10, `found only ${checkers.length} checkers`);
  const unwired = checkers.filter((n) => !CI.includes(`tools/${n}`)).sort();
  assert.deepEqual(
    unwired,
    [],
    `these checkers exist and CI never runs them: ${unwired.join(", ")}`,
  );
});
