// Tests for the cross-server numeric-env-grammar check (#152).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  check,
  numericEnvParsers,
  scopedSourceFiles,
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

// ---------------------------------------------------------------------------
// #170: a trailing comment used to silence a violation.
//
// Every rule in `violationsOf` is stated as "must be PRESENT" — gate on the
// grammar, bound with BigInt, trim before gating — and the local
// `stripComments` removed comment-ONLY lines, so a trailing comment survived
// and was read as code. Measured on one ungated function, twice:
//
//     ungated coercion                                    violations=3
//     IDENTICAL code + trailing comments naming the rules violations=1
//
// #169 diagnosed that exact `stripComments` weakness and fixed it in
// `check-string-env-grammar.mjs` only. Its docstring says why the old rule had
// been fine there — "conservative for a 'this must not appear' check (leaving
// comment text in only ever makes it flag MORE)" — which is a claim about the
// DIRECTION of those rules, and these rules point the other way.
// ---------------------------------------------------------------------------

const UNGATED = `
export function readMax(env) {
  return Number(env.MCP_MAX_BYTES ?? "1000");
}
`;

/** The same code, with trailing comments that name each rule it violates. */
const UNGATED_WITH_TRAILING_COMMENTS = `
export function readMax(env) {
  const raw = env.MCP_MAX_BYTES ?? "1000"; // we used to gate on /^[+-]?\\d+$/ here
  return Number(raw); // and bound it with BigInt(raw) before Number could lose precision
} // the old code called raw.trim() first
`;

test("#170: an ungated coercion is flagged", () => {
  const v = violationsOf(UNGATED);
  assert.equal(v.length, 3, JSON.stringify(v));
});

test("#170: trailing comments naming the rules do not silence the violations", () => {
  // The assertion is the EQUALITY of the two verdicts, not just "still flags
  // something". Before #170 this was 3 vs 1, and asserting only `length > 0`
  // would have passed against that.
  assert.deepEqual(
    violationsOf(UNGATED_WITH_TRAILING_COMMENTS).sort(),
    violationsOf(UNGATED).sort(),
    "a trailing comment changed the verdict",
  );
});

test("#170: the comments in that fixture really do name the rules", () => {
  // Anti-vacuous. If the fixture's comments stopped mentioning the patterns the
  // rules look for, the test above would pass while covering nothing.
  assert.match(UNGATED_WITH_TRAILING_COMMENTS, /\[\+-\]\?\\d\+/, "no grammar mention");
  assert.match(UNGATED_WITH_TRAILING_COMMENTS, /BigInt\(/, "no BigInt mention");
  assert.match(UNGATED_WITH_TRAILING_COMMENTS, /\.trim\(\)/, "no trim mention");
});

test("#170: a correctly gated parser is still clean", () => {
  // The control. A fix that flagged everything would satisfy the rows above.
  const GOOD = `
    const INT_RE = /^[+-]?\\d+$/;
    export function readMax(env) {
      const raw = (env.MCP_MAX_BYTES ?? "1000").trim();
      if (!INT_RE.test(raw)) throw new Error("bad");
      const trimmed = raw;
      if (!(BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER))) throw new Error("too big");
      return Number(raw);
    }
  `;
  assert.deepEqual(violationsOf(GOOD), []);
});

test("#170: the scope exclusion is a named function, and matches what is scanned", () => {
  // The bare `.ts` filter is gone. Every file the scope returns is TypeScript,
  // and the reason for that is written down at `scopedSourceFiles`.
  const scoped = scopedSourceFiles();
  assert.ok(scoped.length > 0, "the scope found no files");
  for (const f of scoped) assert.match(f, /\.ts$/, `${f} is not TypeScript`);
  // And the declared reason names where the Python port is covered instead, so
  // the exclusion cannot become a silent one again.
  const src = readFileSync(new URL("./check-numeric-env-grammar.mjs", import.meta.url), "utf8");
  const doc = src.slice(0, src.indexOf("export function scopedSourceFiles"));
  for (const ref of [
    "check-config-port-parity.mjs",
    "test_max_bytes_parity.py",
    "config.py",
  ]) {
    assert.ok(doc.includes(ref), `the declared scope does not name ${ref}`);
  }
});

test("#170: the Python port the scope excludes really does exist and parse numbers", () => {
  // Anti-vacuous for the reason above: if the Python port went away, the
  // exclusion is explaining a gap that is not there.
  const cfg = readFileSync(
    new URL("../servers/filesystem-sandbox-py/filesystem_sandbox/config.py", import.meta.url),
    "utf8",
  );
  assert.match(cfg, /int\(/, "the Python port no longer coerces an integer");
  assert.match(cfg, /MCP_FS_SANDBOX_MAX_BYTES/);
});
