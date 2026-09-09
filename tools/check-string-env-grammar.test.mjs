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
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRIMS,
  check,
  envAccessNames,
  scopedSourceFiles,
  stringEnvReaders,
  stringEnvReads,
  stripComments,
  uncoveredAccesses,
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

// --- the coverage arm, and the scope declaration (#168) --------------------
//
// The matcher only ever saw an env read BOUND to a variable. Four ordinary
// spellings were not merely unchecked -- they were not counted as reads at all,
// so `readers.length === 0` (which protects against the scan finding NOTHING)
// could not see the scan finding LESS. Measured before this arm existed:
//
//     const raw = env.MCP_X ?? "d";        reads=1  violations=1
//     return env.MCP_X ?? "d";             reads=0  violations=0
//     return env["MCP_X"] ?? "d";          reads=0  violations=0
//     return { label: env.MCP_X ?? "d" };  reads=0  violations=0
//     return use(env.MCP_X ?? "d");        reads=0  violations=0

test("an unbound env read is reported as uncovered, in every spelling", () => {
  const shapes = {
    "direct return": 'export function f(env) { return env.MCP_X_LABEL ?? "d"; }',
    "bracket access": 'export function f(env) { return env["MCP_X_LABEL"] ?? "d"; }',
    "object literal": 'export function f(env) { return { label: env.MCP_X_LABEL ?? "d" }; }',
    "call argument": 'export function f(env) { return use(env.MCP_X_LABEL ?? "d"); }',
  };
  for (const [label, code] of Object.entries(shapes)) {
    assert.deepEqual(
      uncoveredAccesses(code),
      ["MCP_X_LABEL"],
      `${label}: the matcher produced no read and the coverage arm did not notice`,
    );
  }
});

test("a bound read is covered, trimmed or not", () => {
  // The control. The coverage arm asks whether the RULE was applied, not
  // whether it passed -- an untrimmed bound read is a violation of the rule and
  // must not ALSO be reported as uncovered, or one mistake reads as two.
  const untrimmed = 'export function f(env) { const raw = env.MCP_X_LABEL ?? "d"; return raw; }';
  const trimmed =
    'export function f(env) { const raw = (env.MCP_X_LABEL ?? "").trim(); return raw || "d"; }';
  assert.deepEqual(uncoveredAccesses(untrimmed), []);
  assert.deepEqual(violationsOf(untrimmed).length, 1);
  assert.deepEqual(uncoveredAccesses(trimmed), []);
  assert.deepEqual(violationsOf(trimmed), []);
});

test("a setting named only in a comment is not an access", () => {
  // The false positive this arm had on its first run, and the reason
  // `stripComments` now removes TRAILING comments too. A check that fails on
  // correct code is worse than no check.
  assert.deepEqual(envAccessNames('const a = 1; // env.MCP_X_LABEL is documented here'), []);
  assert.deepEqual(envAccessNames('  // env.MCP_X_LABEL'), []);
  assert.deepEqual(envAccessNames('/* env.MCP_X_LABEL */'), []);
  assert.deepEqual(uncoveredAccesses('export function f(env) { // env.MCP_X_LABEL\n return "d"; }'), []);
});

test("a URL is not a comment", () => {
  // `github-gists` has `const DEFAULT_BASE = "https://api.github.com"`. A naive
  // scan for `//` truncates that line at the protocol separator, which would
  // hide every access after it on the same line.
  assert.equal(
    stripComments('const DEFAULT_BASE = "https://api.github.com";'),
    'const DEFAULT_BASE = "https://api.github.com";',
  );
  assert.equal(stripComments('const B = "https://x.test"; // note'), 'const B = "https://x.test"; ');
  assert.equal(stripComments("const a = 1; // don't strip wrongly"), "const a = 1; ");
});

test("numeric settings are not reported as uncovered by the string check", () => {
  // The two checks partition the env surface. Reporting a numeric setting here
  // would make them disagree about one setting the first time either changed --
  // which is the thing this file's header says it is avoiding.
  const code =
    'export function f(env) { const raw = env.MCP_X_TIMEOUT_MS; const n = Number(raw); return n; }';
  assert.deepEqual(uncoveredAccesses(code), []);
});

test("the scope is declared, and it is the scope the walk has", () => {
  // #168: the header says "across the cookbook" and the walk was `.ts` only,
  // silently. `check-boot-config-guard.mjs` excludes the Python port in a
  // function named `typescriptServers` with a written reason; this one said
  // nothing. The exclusion is now a named function, and the Python port is
  // covered by `check-config-port-parity.mjs` instead.
  const files = scopedSourceFiles();
  assert.ok(files.length >= 4, `expected several scoped files, got ${files.length}`);
  assert.ok(files.every((f) => f.endsWith(".ts")));
  assert.ok(
    files.some((f) => f.includes("filesystem-sandbox/src")),
    "the TypeScript filesystem-sandbox port must be in scope",
  );
  assert.ok(
    !files.some((f) => f.includes("filesystem-sandbox-py")),
    "the Python port is out of this check's scope by declaration, not by accident",
  );
});

test("the real tree has no uncovered accesses", () => {
  // Anti-vacuous for the arm against the repo itself, and the assertion that
  // would have gone red had this shipped with the false positive above.
  assert.deepEqual(check().failures, []);
});

test("check() actually wires the coverage arm in, over a planted tree", () => {
  // Falsifying the arms above found this hole: every coverage test called
  // `uncoveredAccesses` DIRECTLY, so removing the loop from `check()` left all
  // of them green. A predicate with no test of its call site is a predicate the
  // next edit can orphan.
  //
  // Planted in a throwaway `servers/` tree rather than the real one, because
  // the real tree has no uncovered access — which is the point of the check and
  // the reason it cannot be the fixture.
  const root = mkdtempSync(join(tmpdir(), "string-env-cover-"));
  try {
    const srcDir = join(root, "planted", "src");
    mkdirSync(srcDir, { recursive: true });
    // Bound + trimmed, so this file is recognised as a reader at all and the
    // failure below cannot come from the file being skipped entirely.
    writeFileSync(
      join(srcDir, "config.ts"),
      [
        "export function readConfig(env) {",
        '  const raw = (env.MCP_PLANTED_BOUND ?? "").trim();',
        '  return { raw: raw || "d", label: env.MCP_PLANTED_UNBOUND ?? "d" };',
        "}",
      ].join("\n"),
      "utf8",
    );
    const { readers, failures } = check(root);
    assert.equal(readers.length, 1, "the planted file must be recognised as a reader");
    assert.equal(failures.length, 1, `expected exactly one failure, got ${JSON.stringify(failures)}`);
    assert.match(failures[0], /MCP_PLANTED_UNBOUND/);
    assert.match(failures[0], /bound to no variable/);
    assert.ok(
      !failures.some((f) => /MCP_PLANTED_BOUND\b/.test(f)),
      "the correctly-written bound read must not be reported",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check() reports an unbound read even when the file has no bound read at all", () => {
  // The harder half: a file whose ONLY env read is unbound produces no readers,
  // so a coverage loop written over `readers` would ask the question of exactly
  // the files that cannot answer it. The loop runs over `scopedSourceFiles()`
  // for this reason.
  const root = mkdtempSync(join(tmpdir(), "string-env-cover-"));
  try {
    const srcDir = join(root, "planted", "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "config.ts"),
      'export function readConfig(env) { return env.MCP_PLANTED_ONLY ?? "d"; }\n',
      "utf8",
    );
    const { readers, failures } = check(root);
    assert.equal(readers.length, 0, "no bound read, so no reader — that is the premise");
    assert.equal(failures.length, 1, `expected the uncovered access, got ${JSON.stringify(failures)}`);
    assert.match(failures[0], /MCP_PLANTED_ONLY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
