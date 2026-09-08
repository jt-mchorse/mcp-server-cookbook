// Tests for `check-string-env-grammar.mjs` (#158).
//
// The checker's whole risk is over-rejection: this repo's notes are explicit
// that a rule which fails on correct code is worse than no rule, and #158 says
// so in its own body. So the file is organised around that — every one of the
// seven real reads is asserted to pass *in isolation*, alongside the broken
// shapes, and the two directions are kept separate so a regression cannot be
// mistaken for the other.
//
// The constructed inputs are minimal source strings rather than the real files,
// per the acceptance criteria: running only against `servers/` would make every
// assertion depend on nobody having changed those files, and would not prove
// the checker can see a defect at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRIMS,
  check,
  stringEnvReaders,
  stringEnvReads,
  stripComments,
  violationsOf,
} from "./check-string-env-grammar.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ */
/* The shapes that must PASS — every real read, in isolation           */
/* ------------------------------------------------------------------ */

// Each entry is the smallest source that reproduces one server's real shape.
// Naming them after the setting is deliberate: when one goes red, the failure
// says which server's pattern the rule just broke.
const REAL_SHAPES = [
  [
    "DATABASE_URL (required, throws on blank)",
    `const connectionString = (process.env.DATABASE_URL ?? "").trim();
     if (!connectionString) { throw new Error("DATABASE_URL is required."); }`,
  ],
  [
    "MCP_BRIDGE_CWD (optional, falls back to cwd)",
    `const cwdRaw = (process.env.MCP_BRIDGE_CWD ?? "").trim();
     const cwd = cwdRaw.length > 0 ? cwdRaw : process.cwd();`,
  ],
  [
    "MCP_GITHUB_GISTS_BASE_URL (defaulted, trim-then-or)",
    `const baseUrl = (env.MCP_GITHUB_GISTS_BASE_URL ?? DEFAULT_BASE).trim() || DEFAULT_BASE;`,
  ],
  [
    "MCP_GITHUB_GISTS_USER_AGENT (defaulted, trim-then-or)",
    `const userAgent = (env.MCP_GITHUB_GISTS_USER_AGENT ?? "").trim() || DEFAULT_UA;`,
  ],
  [
    "GITHUB_TOKEN (optional, trimmed one binding downstream)",
    `const rawToken = env.GITHUB_TOKEN ?? "";
     const token = rawToken.trim().length > 0 ? rawToken.trim() : null;`,
  ],
  [
    "MCP_FS_SANDBOX_ALLOWLIST (required, trimmed per split part)",
    `const raw = env.MCP_FS_SANDBOX_ALLOWLIST ?? "";
     const parts = raw.split(sep).map((p) => configTrim(p)).filter((p) => p.length > 0);
     if (parts.length === 0) { throw new Error("MCP_FS_SANDBOX_ALLOWLIST is required"); }`,
  ],
  [
    "MCP_FS_SANDBOX_READ_ONLY (toggle, configTrim then compare)",
    `const ro = configTrim(env.MCP_FS_SANDBOX_READ_ONLY ?? "").toLowerCase();
     const readOnly = ro === "1" || ro === "true" || ro === "yes";`,
  ],
];

for (const [label, code] of REAL_SHAPES) {
  test(`passes: ${label}`, () => {
    assert.deepEqual(violationsOf(code), [], label);
  });
}

test("the two shapes trimmed a binding downstream are seen as trimmed", () => {
  // This is the pair a same-statement rule would flag, and the reason the
  // binding trace is a fixpoint rather than one pass. Asserted on the
  // classifier directly so the reason is pinned, not just the outcome.
  const gists = stringEnvReads(`const rawToken = env.GITHUB_TOKEN ?? "";
     const token = rawToken.trim().length > 0 ? rawToken.trim() : null;`);
  assert.deepEqual(gists, [{ binding: "rawToken", setting: "GITHUB_TOKEN", trimmed: true }]);

  const fs = stringEnvReads(`const raw = env.MCP_FS_SANDBOX_ALLOWLIST ?? "";
     const parts = raw.split(sep).map((p) => configTrim(p)).filter((p) => p.length > 0);`);
  assert.deepEqual(fs, [
    { binding: "raw", setting: "MCP_FS_SANDBOX_ALLOWLIST", trimmed: true },
  ]);
});

/* ------------------------------------------------------------------ */
/* The shapes that must FAIL                                           */
/* ------------------------------------------------------------------ */

test("the pre-#157 shape is caught: untrimmed read, falsiness test", () => {
  const problems = violationsOf(
    `const connectionString = process.env.DATABASE_URL;
     if (!connectionString) { throw new Error("DATABASE_URL is required."); }`,
  );
  assert.ok(problems.length > 0, "expected the shape #157 fixed to be a violation");
  assert.ok(
    problems.some((p) => /never trimmed/.test(p)),
    `expected a trim complaint, got ${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((p) => /tested for emptiness untrimmed/.test(p)),
    `expected an emptiness complaint, got ${JSON.stringify(problems)}`,
  );
});

// Each row is a distinct way to get the rule wrong. They are separate tests
// because a single "some broken input fails" assertion is satisfied by a
// checker that only sees one of them.
const BROKEN_SHAPES = [
  [
    "untrimmed, blank falls back to a default",
    `const baseUrl = process.env.MCP_GITHUB_GISTS_BASE_URL || DEFAULT_BASE;`,
  ],
  [
    "untrimmed, length test",
    `const token = process.env.GITHUB_TOKEN ?? "";
     const has = token.length > 0;`,
  ],
  [
    "untrimmed, compared against the empty string",
    `const url = process.env.DATABASE_URL ?? "";
     if (url === "") { throw new Error("required"); }`,
  ],
  [
    "trimmed for use but the blank decision reads the raw value",
    `const raw = process.env.DATABASE_URL ?? "";
     const url = raw.trim();
     if (!raw) { throw new Error("required"); }`,
  ],
];

for (const [label, code] of BROKEN_SHAPES) {
  test(`fails: ${label}`, () => {
    assert.ok(violationsOf(code).length > 0, `expected a violation for: ${label}`);
  });
}

test("a read with no trim anywhere is caught even with no emptiness test", () => {
  // Rule A on its own. A required setting used verbatim is the #157 harm
  // whether or not anyone asks if it is blank.
  const problems = violationsOf(`const url = process.env.DATABASE_URL ?? "";
     const client = new Client({ connectionString: url });`);
  assert.ok(problems.some((p) => /DATABASE_URL/.test(p) && /never trimmed/.test(p)));
});

/* ------------------------------------------------------------------ */
/* Over-rejection guards                                               */
/* ------------------------------------------------------------------ */

test("a numeric setting is not this checker's population", () => {
  // `MCP_GITHUB_GISTS_TIMEOUT_MS`'s `!== ""` is deliberate (#152) and correct:
  // a whitespace-only value falls to the numeric grammar gate and is refused
  // loudly. The coercion is two bindings downstream, which is exactly the case
  // the numeric propagation's fixpoint exists for — before it, this was a
  // false positive against the real file.
  const code = `const timeoutRaw = env.MCP_GITHUB_GISTS_TIMEOUT_MS;
     if (timeoutRaw !== undefined && timeoutRaw !== "") {
       const trimmed = timeoutRaw.trim();
       const withinSafeRange = /^[+-]?\\d+$/.test(trimmed) && BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER);
       const parsed = withinSafeRange ? Number(trimmed) : Number.NaN;
     }`;
  assert.deepEqual(violationsOf(code), []);
  assert.deepEqual(stringEnvReads(code), [], "a numeric read must not be a string read");
});

test("a numeric setting coerced only two bindings downstream is still numeric", () => {
  // The `filesystem-sandbox` shape: bare read, `configTrim`ped derivative,
  // `Number` on the derivative's derivative.
  const code = `const maxBytesRaw = env.MCP_FS_SANDBOX_MAX_BYTES;
     const trimmed = configTrim(maxBytesRaw);
     const parsed = Number(trimmed);`;
  assert.deepEqual(stringEnvReads(code), []);
});

test("a defaulted setting is not required to throw", () => {
  // The rule deliberately does not classify required vs defaulted, so it must
  // not demand a blank-rejection from a setting that legitimately defaults.
  assert.deepEqual(
    violationsOf(`const ua = (env.MCP_GITHUB_GISTS_USER_AGENT ?? "").trim() || DEFAULT_UA;`),
    [],
  );
});

test("prose describing the broken shape is not read as code", () => {
  const code = `// Historically this was \`if (!process.env.DATABASE_URL)\` with no trim.
     /* const connectionString = process.env.DATABASE_URL; */
     const connectionString = (process.env.DATABASE_URL ?? "").trim();
     if (!connectionString) { throw new Error("required"); }`;
  assert.deepEqual(violationsOf(code), []);
  assert.ok(!stripComments(code).includes("Historically"));
});

test("a file that reads no env setting at all yields nothing", () => {
  assert.deepEqual(violationsOf(`const x = 1; if (!x) { throw new Error("no"); }`), []);
  assert.deepEqual(stringEnvReads(`export function f() { return 2; }`), []);
});

test("a local that shadows nothing is not mistaken for an env value", () => {
  // `!name` here is a falsiness test on a plain parameter-derived local. The
  // emptiness rule must only fire on identifiers the binding trace marked as
  // carrying an environment value.
  assert.deepEqual(
    violationsOf(`const name = args.name;
       if (!name) { throw new Error("name required"); }
       const url = (process.env.DATABASE_URL ?? "").trim();
       if (!url) { throw new Error("required"); }`),
    [],
  );
});

/* ------------------------------------------------------------------ */
/* Discovery — the anti-vacuous arm                                    */
/* ------------------------------------------------------------------ */

test("discovery finds a string env reader in every server that has one", () => {
  const readers = stringEnvReaders();
  assert.ok(readers.length >= 4, `expected >= 4 readers, got ${readers.length}`);

  // Discovered, not listed: derive the expected server set from the tree.
  const serversWithSrc = readdirSync(join(ROOT, "servers")).filter((s) => {
    const d = join(ROOT, "servers", s, "src");
    return existsSync(d) && statSync(d).isDirectory();
  });
  const covered = new Set(readers.map((r) => r.split("/")[1]));
  const uncovered = serversWithSrc.filter((s) => !covered.has(s));
  assert.deepEqual(
    uncovered,
    [],
    `these servers have a src/ but no discovered string env reader: ${uncovered.join(", ")}`,
  );
});

test("the four servers as they stand pass the check", () => {
  const { readers, failures } = check();
  assert.ok(readers.length > 0, "discovery found nothing — it would pass vacuously");
  assert.deepEqual(failures, []);
});

test("the checker can actually fail — the discovery is not the only moving part", () => {
  // Anti-vacuous mirror of the test above. If `violationsOf` were `() => []`
  // every assertion in the FAIL section would still need to go red; this pins
  // that the real files being clean is a *result*, not the checker being inert.
  const broken = violationsOf(`const url = process.env.DATABASE_URL;
     if (!url) { throw new Error("required"); }`);
  assert.ok(broken.length >= 2, `expected multiple complaints, got ${JSON.stringify(broken)}`);
});

/* ------------------------------------------------------------------ */
/* The trim decision (#158 acceptance criterion 4)                     */
/* ------------------------------------------------------------------ */

test("both trim spellings are accepted, matching the numeric sibling", () => {
  assert.ok(TRIMS.test(`configTrim(x)`));
  assert.ok(TRIMS.test(`x.trim()`));
  assert.deepEqual(
    violationsOf(`const a = configTrim(env.MCP_FS_SANDBOX_READ_ONLY ?? "");
       const b = a === "1";`),
    [],
  );
  assert.deepEqual(
    violationsOf(`const a = (process.env.DATABASE_URL ?? "").trim();
       if (!a) { throw new Error("required"); }`),
    [],
  );
});

test("the decision is written down where the rule lives", () => {
  // #158's fourth acceptance criterion. A decision recorded only in a PR
  // description is one the next reader of this file will not find.
  const source = readFileSync(join(ROOT, "tools/check-string-env-grammar.mjs"), "utf8");
  assert.ok(source.includes("configTrim"), "the trim choice must be discussed in the tool");
  assert.ok(
    /does NOT transfer verbatim/.test(source),
    "the tool must record why the numeric sibling's reason does not carry over",
  );
  assert.ok(/Python port/.test(source), "the tool must say why configTrim exists at all");
});
