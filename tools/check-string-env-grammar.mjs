#!/usr/bin/env node
//
// Every *string* environment setting across the cookbook honours one rule (#158).
//
// The rule, and it is deliberately not two rules:
//
//     A whitespace-only value must be indistinguishable from the setting
//     being absent.
//
// For a required setting that means both throw; for a defaulted one it means
// both give the default. Stating it that way is what lets this check skip the
// hard part #158 names -- deciding which settings are "required" -- because
// the answer is the same either way. A classification by source pattern
// (`?? DEFAULT` / a ternary versus a throw) would be a proxy for the contract,
// and a wrong proxy fails on correct code, which this repo's own notes call
// worse than no rule at all.
//
// `postgres-readonly`'s `DATABASE_URL` was neither trimmed nor blank-checked
// (#157), so one stray space silently redirected the connection to
// `host: base` as the process's OS user -- `pg` stops parsing the value as a
// URL entirely and falls back to keyword/value parsing. `filesystem-sandbox`
// already had the right answer, on both of its settings. Nothing was looking
// at the difference.
//
// Each server here is a standalone, copy-pasteable package: own package.json,
// own lockfile, no workspaces, no cross-server imports. That is the point of a
// cookbook, and it means the config modules cannot share a helper. They share
// a *rule*, and this is what enforces it -- the same role
// `check-numeric-env-grammar.mjs` plays for the numeric grammar and
// `check-boot-config-guard.mjs` plays for the boot-failure contract.
//
// The population is DISCOVERED, not listed. A hand-written list is how
// `github-gists` drifted from a rule this repo had already settled (#152):
// nothing was looking at it.
//
// NUMERIC settings are out of population and belong to
// `check-numeric-env-grammar.mjs`. The two checks partition the env surface
// rather than overlapping: a numeric read's blankness is decided by its
// grammar gate, which is that check's subject, and duplicating it here would
// mean two tools disagreeing about one setting the first time either changed.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS_DIR = join(ROOT, "servers");

/**
 * Trimming, in either spelling this repo uses -- and the decision is the same
 * one `check-numeric-env-grammar.mjs` made, with one caveat that is worth
 * writing down because its stated reason does NOT transfer verbatim.
 *
 * That check argues the two spellings "differ in strictness, never in safety",
 * because a value padded with Python's extra whitespace (`U+0085`,
 * `U+001C`-`U+001F`) still fails the numeric grammar gate that follows the
 * trim. For a *string* setting nothing follows, so a `U+0085`-padded
 * `DATABASE_URL` survives the narrow `.trim()` with the `U+0085` still
 * attached.
 *
 * That changes the size of the hazard, not its direction. The residue case is
 * a value that is *mostly* whitespace rather than one that is *blank*, which
 * is strictly smaller than the #157 defect this rule exists for, and it is the
 * same trade the numeric check consciously accepts. `configTrim` exists in
 * `filesystem-sandbox` because that server has a **Python port** reading the
 * same variables and JS `\s` and Python `str.strip()` disagree on six
 * codepoints (#52/#98). The other three servers have no second port.
 * Requiring `configTrim` on them would be inventing a requirement -- which is
 * the failure the numeric check's own comment records it having made once,
 * when it flagged the reference implementation.
 */
export const TRIMS = /configTrim\(|\.trim\(\)/;

/** A read of a *named* environment variable: `env.NAME` or `process.env.NAME`. */
const NAMED_ENV_READ = /\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)\b/;

/**
 * Numeric coercion, which moves a setting into the numeric check's population.
 *
 * Matched on the coercion rather than on the variable's name, for the same
 * reason `check-numeric-env-grammar.mjs` does: the coercion is the thing with
 * a grammar. A setting named `..._MS` that is never coerced is a string.
 */
const NUMERIC_COERCION = /\bNumber\s*\(|\bNumber\.parseInt\s*\(|\bBigInt\s*\(/;

/**
 * An emptiness/falsiness decision.
 *
 * These are the shapes the four servers actually use to ask "is this setting
 * effectively unset?", plus the bare falsiness test that #157 was. `|| X` is
 * included because `(...).trim() || DEFAULT` is exactly how `github-gists`
 * spells "blank falls back", and a bare `x || DEFAULT` on an untrimmed value
 * is the same defect wearing a default instead of a throw.
 */
// `MCP_GITHUB_GISTS_TIMEOUT_MS` is the one setting whose blank test is
// deliberately `!== ""` rather than `.trim() !== ""`, and it is *consistent*
// with the rule rather than an exception to it: a whitespace-only value there
// falls through to the numeric grammar gate and is refused loudly, which is
// distinguishable from absent in the direction the operator wants. It is
// excluded here because it is numeric, not because it is special — which is
// why the numeric propagation above has to reach it.
const EMPTINESS_TESTS = [
  /!\s*([A-Za-z_$][\w$]*)\b(?!\s*[.(])/g,
  /\b([A-Za-z_$][\w$]*)\s*\.length\s*(?:>|===|!==|==|!=|<)/g,
  /\b([A-Za-z_$][\w$]*)\s*(?:===|!==|==|!=)\s*""/g,
  /\b([A-Za-z_$][\w$]*)\s*\|\|/g,
];

/** Strip comments so prose *describing* the old shape is not read as code. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** `const`/`let`/`var` bindings as `{ name, init }`, initializer text only. */
function bindingsOf(code) {
  const out = [];
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([^;]+);/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push({ name: m[1], init: m[2] });
  return out;
}

const mentions = (text, name) => new RegExp(`\\b${name}\\b`).test(text);

/**
 * Trace which bindings carry an environment value, and which of those have
 * been trimmed by the time they are bound.
 *
 * A fixpoint rather than a single pass, because the trim is routinely one
 * binding downstream of the read -- `rawToken` then `token`, `raw` then
 * `parts`. That distance is the reason a same-statement rule would fail on
 * correct code: two of the seven real reads are not trimmed where they are
 * read.
 */
export function envBindings(code) {
  const binds = bindingsOf(code);
  const known = new Map();
  for (let pass = 0; pass < binds.length + 1; pass++) {
    let changed = false;
    for (const b of binds) {
      const direct = NAMED_ENV_READ.test(b.init);
      const derived = [...known.keys()].some((n) => mentions(b.init, n));
      if (!direct && !derived) continue;
      const trimmed =
        TRIMS.test(b.init) ||
        [...known.entries()].some(([n, v]) => v.trimmed && mentions(b.init, n));
      const numeric =
        NUMERIC_COERCION.test(b.init) ||
        [...known.entries()].some(([n, v]) => v.numeric && mentions(b.init, n));
      const next = { name: b.name, init: b.init, direct, trimmed, numeric };
      const prev = known.get(b.name);
      if (!prev || prev.trimmed !== trimmed || prev.numeric !== numeric) {
        known.set(b.name, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // A read is numeric if *anything* downstream coerces it, and the coercion is
  // routinely two bindings away: `timeoutRaw` -> `trimmed` -> `withinSafeRange`
  // is where the `BigInt` finally appears, and `maxBytesRaw` -> `trimmed` ->
  // `parsed` is the same shape one server over. A single backward pass gets the
  // right answer only if the Map happens to be ordered helpfully, so this walks
  // to a fixpoint. Getting it wrong flags `MCP_GITHUB_GISTS_TIMEOUT_MS`'s
  // deliberate `!== ""` (see below) as a violation — a rule failing on correct
  // code, which is the outcome #158 warns about by name.
  for (let pass = 0; pass < known.size + 1; pass++) {
    let changed = false;
    for (const [, v] of known) {
      if (!v.numeric) continue;
      for (const [, other] of known) {
        if (!other.numeric && mentions(v.init, other.name)) {
          other.numeric = true;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return known;
}

/** The named string settings a file reads, with their trim status. */
export function stringEnvReads(code) {
  const stripped = stripComments(code);
  const known = envBindings(stripped);
  const out = [];
  for (const [name, v] of known) {
    if (!v.direct || v.numeric) continue;
    const setting = v.init.match(NAMED_ENV_READ)?.[1] ?? name;
    const trimmedDownstream =
      v.trimmed || [...known.values()].some((o) => o.trimmed && mentions(o.init, name));
    out.push({ binding: name, setting, trimmed: trimmedDownstream });
  }
  return out.sort((a, b) => (a.setting < b.setting ? -1 : a.setting > b.setting ? 1 : 0));
}

export function violationsOf(code) {
  const stripped = stripComments(code);
  const reads = stringEnvReads(code);
  if (reads.length === 0) return [];
  const known = envBindings(stripped);
  const problems = [];

  // Rule A: the value must be trimmed somewhere before anything reads it.
  for (const r of reads) {
    if (!r.trimmed) {
      problems.push(
        `${r.setting} is read into \`${r.binding}\` and never trimmed — ` +
          `a padded value reaches the setting verbatim`,
      );
    }
  }

  // Rule B: every emptiness decision is made on a trimmed operand. This is the
  // rule that catches #157's actual shape — a falsiness test on the raw value.
  for (const re of EMPTINESS_TESTS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const operand = m[1];
      const info = known.get(operand);
      if (!info || info.numeric || info.trimmed) continue;
      problems.push(
        `\`${operand}\` carries an environment value and is tested for emptiness ` +
          `untrimmed (\`${m[0].trim()}\`) — a whitespace-only value passes as set`,
      );
    }
  }
  return [...new Set(problems)];
}

/** Every TypeScript source file under `servers/` that reads a string env setting. */
export function stringEnvReaders(serversDir = SERVERS_DIR) {
  const found = [];
  for (const server of readdirSync(serversDir)) {
    const srcDir = join(serversDir, server, "src");
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith(".ts")) continue;
      const file = join(srcDir, name);
      if (stringEnvReads(readFileSync(file, "utf8")).length > 0) found.push(relative(ROOT, file));
    }
  }
  return found.sort();
}

export function check(serversDir = SERVERS_DIR) {
  const failures = [];
  const readers = stringEnvReaders(serversDir);
  for (const rel of readers) {
    for (const p of violationsOf(readFileSync(join(ROOT, rel), "utf8"))) {
      failures.push(`${rel}: ${p}`);
    }
  }
  return { readers, failures };
}

function main() {
  const { readers, failures } = check();
  if (readers.length === 0) {
    process.stderr.write(
      "check-string-env-grammar: found no string env readers at all — the discovery is broken, " +
        "which would otherwise pass vacuously.\n",
    );
    process.exit(2);
  }
  if (failures.length > 0) {
    process.stderr.write(
      `check-string-env-grammar: ${failures.length} problem(s) across ${readers.length} reader(s):\n` +
        failures.map((f) => `  - ${f}\n`).join("") +
        "\nEvery string env setting in this cookbook honours one rule: a whitespace-only\n" +
        "value is indistinguishable from the setting being absent. Trim the value, and\n" +
        "make the blank decision on the trimmed result — throw for a required setting,\n" +
        "fall back for a defaulted one.\n" +
        "See servers/postgres-readonly/src/db.ts for the reference (#157/#158).\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-string-env-grammar: ${readers.length} reader(s) honour one rule\n` +
      readers.map((p) => `  - ${p}\n`).join(""),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
