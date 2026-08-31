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

/** Strip comments so prose *describing* the old shape is not read as code. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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

/** Every TypeScript source file under `servers/` that parses a numeric env var. */
export function numericEnvParsers(serversDir = SERVERS_DIR) {
  const found = [];
  for (const server of readdirSync(serversDir)) {
    const srcDir = join(serversDir, server, "src");
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith(".ts")) continue;
      const file = join(srcDir, name);
      const code = stripComments(readFileSync(file, "utf8"));
      if (parsesNumericEnv(code)) found.push(relative(ROOT, file));
    }
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
