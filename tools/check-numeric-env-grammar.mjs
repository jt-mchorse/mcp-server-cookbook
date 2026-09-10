#!/usr/bin/env node
//
// Every numeric environment variable across the cookbook parses the same
// grammar (#152).
//
// `postgres-readonly` read its two numeric settings through
// `Number.parseInt(raw, 10)`, which stops at the first character it cannot
// consume and returns what it has -- so `STATEMENT_TIMEOUT_MS=5s` became five
// *milliseconds*, and the error message claimed the value was a positive
// integer when it wasn't. Running that table across every server found a
// second one: `github-gists` used bare `Number()`, which takes `0x10` as 16
// and `1e3` as 1000, with `Number.isInteger` true for both.
//
// `filesystem-sandbox` was already right. #98 unified the grammar across its
// two *ports* (TypeScript and Python) and #137 bounded the magnitude, and its
// config names `0x10` and `1e6` as exactly the forms `Number()` wrongly
// accepts -- so the correct answer was written down in this repo and two other
// servers did not have it.
//
// Each server here is a standalone, copy-pasteable package: own package.json,
// own lockfile, no workspaces, no cross-server imports. That is the point of a
// cookbook, and it means the three parsers cannot share a module. They share a
// *grammar*, and this is what enforces it -- the same role
// `check-boot-config-guard.mjs` plays for the boot-failure contract.
//
// The population is DISCOVERED, not listed. A hand-written list is how
// `github-gists` drifted from a rule this repo had already settled: nothing was
// looking at it.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stripComments } from "./lib/strip-comments.mjs";

import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS_DIR = join(ROOT, "servers");

/** The settled grammar gate: trim, then plain base-10 digits with an optional sign. */
export const GRAMMAR_GATE = /\/\^\[\+-\]\?\\d\+\$\//;

/** The precision bound: reject above MAX_SAFE_INTEGER before `Number` sees it. */
export const SAFE_RANGE_BOUND = /BigInt\(\s*trimmed\s*\)\s*<=\s*BigInt\(\s*Number\.MAX_SAFE_INTEGER\s*\)/;

/**
 * Trimming, in either spelling this repo uses.
 *
 * `filesystem-sandbox` trims with `configTrim`, a deliberately widened class
 * (`\s` plus `U+0085` and `U+001C`-`U+001F`) that exists because that server has
 * a **Python port** reading the same variables, and JS `\s` and Python
 * `str.strip()` disagree on six codepoints -- #52 traced a `U+0085` on the
 * read-only toggle failing *open* on one port. The other servers have no second
 * port, and JS `.trim()` already covers `U+FEFF`, which is the realistic case
 * (a `.env` saved as UTF-8-with-BOM). Requiring `configTrim` everywhere would
 * be inventing a requirement, and this check flagged the reference
 * implementation when it did.
 *
 * A value padded with Python's extras still fails *loudly* on the narrower
 * trim -- the grammar gate rejects it -- so the two spellings differ in
 * strictness, never in safety.
 */
const TRIMS = /configTrim\(|\.trim\(\)/;

// `stripComments` comes from `tools/lib/strip-comments.mjs` since #170. The
// local copy stripped comment-ONLY lines, so a trailing comment survived and
// was read as code -- and every rule in `violationsOf` below is stated as "must
// be PRESENT", so that made it flag FEWER, not more. Measured on one ungated
// function: 3 violations bare, 1 with trailing comments naming the rules.
//
// Re-exported because `check-numeric-env-grammar.test.mjs` imports it from
// here.
export { stripComments };

/**
 * A source file parses a numeric env var when it coerces a value that came
 * from the environment. Matched on the coercion, because that is the thing
 * with a grammar.
 */
export function parsesNumericEnv(code) {
  return /process\.env|readDbConfigFromEnv|env\./.test(code) && /Number\.parseInt\(|Number\(/.test(code);
}

export function violationsOf(code) {
  const stripped = stripComments(code);
  if (!parsesNumericEnv(stripped)) return [];
  const problems = [];
  if (/Number\.parseInt\(/.test(stripped)) {
    problems.push("uses Number.parseInt, which stops at the first unconsumable character");
  }
  if (!GRAMMAR_GATE.test(stripped)) {
    problems.push("does not gate on the /^[+-]?\\d+$/ grammar before coercing");
  }
  if (!SAFE_RANGE_BOUND.test(stripped)) {
    problems.push("does not bound the magnitude with BigInt before Number can lose precision");
  }
  if (!TRIMS.test(stripped)) {
    problems.push("does not trim before gating");
  }
  return problems;
}

/**
 * Every source file this check can read, with the scope DECLARED (#170).
 *
 * TypeScript only, and the reason is written down here rather than left as an
 * unexplained `.ts` in a loop -- which is exactly what
 * `check-string-env-grammar.mjs` called out about its own filter in #168, under
 * a header that says "across the cookbook". This one had the same bare filter
 * under the same kind of header, and #168 fixed only the sibling.
 *
 * The reason is the same as that sibling's and just as weak, so it is stated
 * the same way. The rule is language-independent: a numeric setting should
 * accept one grammar in any language. The exclusion is purely about the
 * MATCHER, which reads TypeScript coercions (`Number(`, `Number.parseInt(`)
 * and TypeScript idioms; teaching it Python would be a second matcher for a
 * second language, and pointing these regexes at `config.py` would be worse
 * than the gap -- a check that fails on correct code is worse than no check.
 *
 * So the Python port is covered by three other things instead, and the gap is
 * closed rather than merely declared:
 * `tools/check-config-port-parity.mjs` asserts the two `filesystem-sandbox`
 * ports read the same set of settings;
 * `servers/filesystem-sandbox-py/tests/test_max_bytes_parity.py` pins the
 * numeric grammar row for row against the TS port; and
 * `servers/filesystem-sandbox-py/filesystem_sandbox/config.py` documents the
 * grammar it implements (#98, #137).
 *
 * What none of those gives is what this file gives the TS servers: a rule that
 * a NEW Python server would inherit without anyone remembering. That is a real
 * remaining gap and it is named rather than papered over -- there is one Python
 * server today, and if a second arrives this reason expires.
 */
export function scopedSourceFiles(serversDir = SERVERS_DIR) {
  const found = [];
  for (const server of readdirSync(serversDir)) {
    const srcDir = join(serversDir, server, "src");
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith(".ts")) continue;
      found.push(join(srcDir, name));
    }
  }
  return found.sort();
}

/** Every TypeScript source file under `servers/` that parses a numeric env var. */
export function numericEnvParsers(serversDir = SERVERS_DIR) {
  const found = [];
  for (const file of scopedSourceFiles(serversDir)) {
    const code = stripComments(readFileSync(file, "utf8"));
    if (parsesNumericEnv(code)) found.push(relative(ROOT, file));
  }
  return found.sort();
}

export function check(serversDir = SERVERS_DIR) {
  const failures = [];
  const parsers = numericEnvParsers(serversDir);
  for (const rel of parsers) {
    const problems = violationsOf(readFileSync(join(ROOT, rel), "utf8"));
    for (const p of problems) failures.push(`${rel}: ${p}`);
  }
  return { parsers, failures };
}

function main() {
  const { parsers, failures } = check();
  if (parsers.length === 0) {
    process.stderr.write(
      "check-numeric-env-grammar: found no numeric env parsers at all — the discovery is broken, " +
        "which would otherwise pass vacuously.\n",
    );
    process.exit(2);
  }
  if (failures.length > 0) {
    process.stderr.write(
      `check-numeric-env-grammar: ${failures.length} problem(s) across ${parsers.length} parser(s):\n` +
        failures.map((f) => `  - ${f}\n`).join("") +
        "\nEvery numeric env var in this cookbook parses one grammar: trim, gate on\n" +
        "/^[+-]?\\d+$/, bound with BigInt against MAX_SAFE_INTEGER, then Number.\n" +
        "See servers/filesystem-sandbox/src/config.ts for the reference (#98/#137/#152).\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-numeric-env-grammar: ${parsers.length} parser(s) share one grammar\n` +
      parsers.map((p) => `  - ${p}\n`).join(""),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
