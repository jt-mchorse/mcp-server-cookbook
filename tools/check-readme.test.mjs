// Tests for tools/check-readme.mjs.
//
// Uses node:test (stdlib) so this file is runnable without installing
// vitest or jest. The CI job runs `node --test tools/check-readme.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countTestsInFile,
  parametrizeCases,
  readmeServerRefs,
  readmeTestCountClaims,
  topLevelCommasInList,
} from "./check-readme.mjs";

test("readmeServerRefs collects unique servers/<name> references", () => {
  const md = [
    "blah `servers/postgres-readonly` blah",
    "see [servers/filesystem-sandbox/README.md](servers/filesystem-sandbox/README.md)",
    "cd servers/github-gists && npm test",
    "cd servers/postgres-readonly && npm install",
  ].join("\n");
  assert.deepEqual(readmeServerRefs(md), [
    "filesystem-sandbox",
    "github-gists",
    "postgres-readonly",
  ]);
});

test("readmeServerRefs returns empty array when README has no references", () => {
  assert.deepEqual(readmeServerRefs("plain prose with nothing"), []);
});

test("readmeTestCountClaims parses cd ... # <n> lines", () => {
  const md = [
    "```bash",
    "cd servers/postgres-readonly      && npm install && npm test    # 38 SQL-guard tests",
    "cd servers/filesystem-sandbox     && npm install && npm test    # 38 sandbox + tool + config tests",
    "cd servers/filesystem-sandbox-py  && pip install -e '.[dev]' && pytest  # 54 sandbox + tool + config tests",
    "```",
  ].join("\n");
  const claims = readmeTestCountClaims(md);
  assert.equal(claims.length, 3);
  assert.deepEqual(claims.map((c) => c.server), [
    "postgres-readonly",
    "filesystem-sandbox",
    "filesystem-sandbox-py",
  ]);
  assert.deepEqual(claims.map((c) => c.count), [38, 38, 54]);
});

test("readmeTestCountClaims ignores lines without a numeric # comment", () => {
  const md = [
    "cd servers/foo && npm install && npm run build",
    "cd servers/bar && npm test    # smoke test only",
    "cd servers/baz && npm test    # 12 tests",
  ].join("\n");
  const claims = readmeTestCountClaims(md);
  assert.deepEqual(
    claims.map((c) => ({ server: c.server, count: c.count })),
    [{ server: "baz", count: 12 }],
  );
});

test("topLevelCommasInList counts simple cases", () => {
  assert.equal(topLevelCommasInList('["a", "b", "c"]'), 2);
  assert.equal(topLevelCommasInList("[1, 2, 3, 4]"), 3);
  assert.equal(topLevelCommasInList("[]"), 0);
  assert.equal(topLevelCommasInList('["only"]'), 0);
});

test("topLevelCommasInList ignores commas inside quoted strings", () => {
  assert.equal(topLevelCommasInList('["a,b", "c,d"]'), 1);
  assert.equal(topLevelCommasInList("['a,b', 'c,d', 'e,f']"), 2);
});

test("topLevelCommasInList handles escaped quotes in strings", () => {
  // List with one element that contains an escaped quote — zero top-level commas.
  assert.equal(topLevelCommasInList('["he said \\"hi, friend\\""]'), 0);
});

test("topLevelCommasInList returns null for non-bracket input", () => {
  assert.equal(topLevelCommasInList("not a list"), null);
  assert.equal(topLevelCommasInList("[unclosed"), null);
  assert.equal(topLevelCommasInList(""), null);
});

test("parametrizeCases counts a real parametrize line", () => {
  const line =
    '@pytest.mark.parametrize("ch", ["\\x01", "\\x09", "\\x0a", "\\x1f", "\\x7f"])';
  assert.equal(parametrizeCases(line), 5);
});

test("parametrizeCases returns null when no list is present", () => {
  assert.equal(parametrizeCases("@pytest.mark.parametrize(strategy_name)"), null);
});

test("countTestsInFile counts vitest `it(` and `test(`", () => {
  const src = [
    "import { describe, it, test } from 'vitest';",
    "describe('group', () => {",
    "  it('a', () => {});",
    "  it.skip('b', () => {});",
    "  it.only('c', () => {});",
    "  test('d', () => {});",
    "  test.skip('e', () => {});",
    "});",
  ].join("\n");
  assert.equal(countTestsInFile("foo.test.ts", src), 5);
});

test("countTestsInFile ignores identifiers that contain 'test'", () => {
  const src = [
    "function attest() {}",
    "const fastest = 1;",
    "it('real test', () => {});",
  ].join("\n");
  assert.equal(countTestsInFile("foo.test.ts", src), 1);
});

test("countTestsInFile ignores // comments", () => {
  const src = ["// it('fake', () => {});", "it('real', () => {});"].join("\n");
  assert.equal(countTestsInFile("foo.test.ts", src), 1);
});

test("countTestsInFile counts python def test_* with no decorators as 1 each", () => {
  const src = [
    "def test_a():",
    "    pass",
    "",
    "def test_b():",
    "    pass",
  ].join("\n");
  assert.equal(countTestsInFile("test_x.py", src), 2);
});

test("countTestsInFile multiplies python def by single parametrize decorator", () => {
  const src = [
    '@pytest.mark.parametrize("v", ["a", "b", "c"])',
    "def test_truthy(v):",
    "    pass",
  ].join("\n");
  assert.equal(countTestsInFile("test_x.py", src), 3);
});

test("countTestsInFile multiplies python def by stacked parametrize decorators", () => {
  const src = [
    '@pytest.mark.parametrize("v", ["a", "b"])',
    '@pytest.mark.parametrize("w", [1, 2, 3])',
    "def test_cross(v, w):",
    "    pass",
  ].join("\n");
  assert.equal(countTestsInFile("test_x.py", src), 6);
});

test("countTestsInFile resets the parametrize factor after the def", () => {
  const src = [
    '@pytest.mark.parametrize("v", ["a", "b"])',
    "def test_first(v):",
    "    pass",
    "",
    "def test_second():",  // no decorator → single case, not 2
    "    pass",
  ].join("\n");
  assert.equal(countTestsInFile("test_x.py", src), 3);
});

test("countTestsInFile ignores python # comments and non-decorator lines between decorator and def", () => {
  const src = [
    '@pytest.mark.parametrize("v", ["a", "b", "c"])',
    "# a comment between decorator and def",
    "def test_explained(v):",
    "    pass",
  ].join("\n");
  // The comment line doesn't break the decorator-to-def chain.
  assert.equal(countTestsInFile("test_x.py", src), 3);
});

test("countTestsInFile breaks the decorator chain on non-decorator code", () => {
  const src = [
    '@pytest.mark.parametrize("v", ["a", "b", "c"])',
    "x = 1",  // unrelated code
    "def test_after_unrelated():",
    "    pass",
  ].join("\n");
  // The `x = 1` line breaks the chain, so the def counts as 1, not 3.
  assert.equal(countTestsInFile("test_x.py", src), 1);
});
