// Tests for the cross-server numeric-env-grammar check (#152).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  check,
  numericEnvParsers,
  stripComments,
  violationsOf,
} from "./check-numeric-env-grammar.mjs";

const REFERENCE = `
  const trimmed = raw.trim();
  const withinSafeRange =
    /^[+-]?\\d+$/.test(trimmed) && BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER);
  const n = withinSafeRange ? Number(trimmed) : Number.NaN;
  const raw2 = process.env.X;
`;

test("the repo currently satisfies the grammar", () => {
  const { parsers, failures } = check();
  assert.deepEqual(failures, []);
  // Anti-vacuous: every assertion is a loop over `parsers`, so an empty
  // discovery would report zero failures. #152's whole point is that a
  // hand-listed population cannot see a new member.
  assert.ok(parsers.length >= 3, `expected >= 3 parsers, found ${parsers.length}`);
});

test("it discovers all three servers that parse a numeric env var", () => {
  const found = numericEnvParsers();
  for (const expected of [
    "servers/filesystem-sandbox/src/config.ts",
    "servers/github-gists/src/config.ts",
    "servers/postgres-readonly/src/db.ts",
  ]) {
    assert.ok(found.includes(expected), `${expected} not discovered; found ${found.join(", ")}`);
  }
});

test("a compliant parser has no violations", () => {
  assert.deepEqual(violationsOf(REFERENCE), []);
});

test("Number.parseInt is caught by name", () => {
  const src = REFERENCE.replace("Number(trimmed)", "Number.parseInt(trimmed, 10)");
  assert.ok(
    violationsOf(src).some((v) => v.includes("Number.parseInt")),
    "the #152 defect itself must be caught",
  );
});

test("a missing grammar gate is caught", () => {
  const src = `const raw = process.env.X; const n = Number(raw.trim());`;
  const v = violationsOf(src);
  assert.ok(v.some((p) => p.includes("grammar")), v.join("; "));
  assert.ok(v.some((p) => p.includes("BigInt")), v.join("; "));
});

test("a missing trim is caught", () => {
  const src = REFERENCE.replace("raw.trim()", "raw").replace(/\.trim\(\)/g, "");
  assert.ok(violationsOf(src).some((p) => p.includes("trim")), "untrimmed parser must fail");
});

test("configTrim counts as trimming", () => {
  // filesystem-sandbox uses a widened trim for Python-port parity. Requiring
  // `.trim()` literally flagged the *reference* implementation — a check that
  // fails on code that is right is worse than no check.
  const src = REFERENCE.replace("raw.trim()", "configTrim(raw)").replace(
    /trimmed\.trim\(\)/g,
    "trimmed",
  );
  assert.deepEqual(
    violationsOf(src).filter((p) => p.includes("trim")),
    [],
  );
});

test("a file that does not parse a numeric env var is not judged", () => {
  // The rule applies to numeric env parsing, not to every file. A server that
  // reads a string env var must not be dragged in.
  assert.deepEqual(violationsOf(`const s = process.env.NAME ?? "";`), []);
});

test("comments describing the old shape are not read as code", () => {
  // Every hardened parser now quotes `Number.parseInt` while explaining #152.
  // Scanning raw source would flag the explanation as the defect.
  const src = `// was: Number.parseInt(raw, 10)\n/* and Number(raw) */\n${REFERENCE}`;
  assert.ok(/Number\.parseInt\(/.test(src));
  assert.ok(!/Number\.parseInt\(/.test(stripComments(src)));
  assert.deepEqual(violationsOf(src), []);
});
