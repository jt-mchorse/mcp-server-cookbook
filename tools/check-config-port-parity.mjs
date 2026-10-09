#!/usr/bin/env node
//
// The two `filesystem-sandbox` ports read the same set of env settings (#168).
//
// `servers/filesystem-sandbox` (TypeScript) and `servers/filesystem-sandbox-py`
// (Python) are the same server twice, and this repo has fixed four separate
// divergences between them: the read-only toggle failing open (#52), the byte
// cap's grammar (#98), its value domain (#137), and the trim character class
// (#139). Every one of those was found by hand.
//
// What was watching the pair afterwards, and what each thing cannot see:
//
//   check-string-env-grammar.mjs   .ts only -- the Python port is invisible
//   check-numeric-env-grammar.mjs  .ts only -- likewise
//   test_config_trim_parity.py     excellent, and it enumerates the three
//     + its TS mirror              settings BY HAND (read_only / allowlist /
//                                  max_bytes), so a FOURTH setting added to
//                                  one port gets no coverage from it
//
// So the drift class nothing covered is the simplest one: a setting exists in
// one port and not the other. This check is that, and only that. It reads the
// variable NAMES out of both config modules and compares the sets.
//
// Deliberately NOT a Python grammar matcher. The two grammar checkers enforce
// how a value is read; teaching either to parse Python would be a second
// matcher for a second language, and the behavioural parity tests already pin
// how these three settings behave row for row. What no one had was the
// question of WHICH settings exist. A check that answers one question
// completely beats one that answers two badly.
//
// The exclusion in `check-boot-config-guard.mjs` is the model for how this
// repo declares scope: a function named `typescriptServers` and a written
// reason. The two grammar checkers said nothing at all, which is what #168 is
// about.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The two halves of the ported pair, and the file in each that reads env. */
export const PORTED_PAIR = {
  ts: "servers/filesystem-sandbox/src/config.ts",
  py: "servers/filesystem-sandbox-py/filesystem_sandbox/config.py",
};

/**
 * Env variable names a source file reads.
 *
 * Matched on the NAME's own shape (`MCP_`-prefixed SCREAMING_SNAKE) rather than
 * on either language's access syntax, because the access syntax is exactly what
 * differs between the ports -- `env.NAME`, `env["NAME"]`, `e.get("NAME", "")`.
 * A matcher keyed on syntax would need to know both languages; one keyed on the
 * name needs to know neither, and this repo's settings all carry the prefix.
 *
 * Comments are stripped first in both languages, so the paragraph in each
 * config module that NAMES all three settings does not count as reading them --
 * that is the false-hit shape a grep would have.
 */
export function settingsRead(code) {
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*#.*$/gm, "")
    .replace(/"""[\s\S]*?"""/g, "");
  return [...new Set(stripped.match(/\bMCP_[A-Z0-9_]+\b/g) ?? [])].sort();
}

export function check(root = ROOT) {
  const failures = [];
  const read = {};
  for (const [port, rel] of Object.entries(PORTED_PAIR)) {
    const file = join(root, rel);
    if (!existsSync(file)) {
      failures.push(`${rel}: missing; the ported pair is defined by these two files`);
      continue;
    }
    read[port] = settingsRead(readFileSync(file, "utf8"));
  }
  if (failures.length > 0) return { read, failures };

  const onlyTs = read.ts.filter((n) => !read.py.includes(n));
  const onlyPy = read.py.filter((n) => !read.ts.includes(n));
  for (const name of onlyTs) {
    failures.push(`${name} is read by the TypeScript port but not by the Python one`);
  }
  for (const name of onlyPy) {
    failures.push(`${name} is read by the Python port but not by the TypeScript one`);
  }
  return { read, failures };
}

function main() {
  const { read, failures } = check();
  const count = read.ts?.length ?? 0;
  if (count === 0) {
    process.stderr.write(
      "check-config-port-parity: found no settings in the TypeScript port at all — the " +
        "discovery is broken, which would otherwise pass vacuously.\n",
    );
    process.exit(2);
  }
  if (failures.length > 0) {
    process.stderr.write(
      `check-config-port-parity: ${failures.length} divergence(s):\n` +
        failures.map((f) => `  - ${f}\n`).join("") +
        "\n`servers/filesystem-sandbox` and `servers/filesystem-sandbox-py` are the same\n" +
        "server twice. A setting that exists in one port and not the other is a config an\n" +
        "operator can write for one and not the other, and this repo has fixed four\n" +
        "port divergences by hand already (#52, #98, #137, #139).\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-config-port-parity: both ports read the same ${count} setting(s)\n` +
      read.ts.map((n) => `  - ${n}\n`).join(""),
  );
}

if (isMain(import.meta.url)) main();
