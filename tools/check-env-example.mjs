#!/usr/bin/env node
//
// Each server's `.env.example` lists exactly the env variables it reads (#185).
//
// The handoff rule (portfolio-ops#80) is one `.env.example` per repo that reads
// configuration from the environment. Here every server is its own project with
// its own environment, so the unit is the server: before #185 only
// `postgres-readonly` had one, and nothing checked that it was complete.
//
// The names are derived from each server's non-test source, so a new variable
// fails here until it is listed, and a listed variable nobody reads fails too.
//
// Keyed on ACCESS SYNTAX, not on the name's shape. `check-config-port-parity`
// matches `MCP_`-prefixed names because its question is which settings the two
// filesystem ports share, and every one of those carries the prefix. This
// question covers `GITHUB_TOKEN`, `DATABASE_URL` and `MAX_ROWS`, which don't.
// The spellings, all of which this repo uses:
//
//   process.env.NAME    process.env["NAME"]    env.NAME    env["NAME"]
//   parseIntEnv("NAME", ...)                   (postgres-readonly)
//   e.get("NAME", ...) / env.get / environ.get / os.getenv("NAME")   (Python)
//
// `internal-tools-bridge`'s ENV_PASSLIST (`PATH`, `LANG`, ...) is not matched:
// those are handed through to child processes, not read as configuration.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { stripComments } from "./lib/strip-comments.mjs";
import { REPO_ROOT } from "./lib/tools-files.mjs";
import { isMain } from "./lib/is-main.mjs";

const NAME = "([A-Z][A-Z0-9_]*)";
const Q = `["']`;

const TS_READS = [
  new RegExp(`\\bprocess\\.env\\.${NAME}\\b`, "g"),
  new RegExp(`\\bprocess\\.env\\[\\s*${Q}${NAME}${Q}\\s*\\]`, "g"),
  new RegExp(`(?<![\\w.])env\\.${NAME}\\b`, "g"),
  new RegExp(`(?<![\\w.])env\\[\\s*${Q}${NAME}${Q}\\s*\\]`, "g"),
  new RegExp(`\\bparseIntEnv\\(\\s*${Q}${NAME}${Q}`, "g"),
];

const PY_READS = [
  new RegExp(`(?<![\\w.])(?:e|env|environ|os\\.environ)\\.get\\(\\s*${Q}${NAME}${Q}`, "g"),
  new RegExp(`\\bos\\.getenv\\(\\s*${Q}${NAME}${Q}`, "g"),
  new RegExp(`\\bos\\.environ\\[\\s*${Q}${NAME}${Q}\\s*\\]`, "g"),
];

/** Python: drop docstrings and whole-line comments, so prose naming a variable is not a read. */
function stripPython(src) {
  return src.replace(/"""[\s\S]*?"""/g, "").replace(/^\s*#.*$/gm, "");
}

/** Env variable names a source file reads, by language. */
export function envNamesRead(code, lang) {
  const stripped = lang === "py" ? stripPython(code) : stripComments(code);
  const names = new Set();
  for (const re of lang === "py" ? PY_READS : TS_READS) {
    for (const m of stripped.matchAll(re)) names.add(m[1]);
  }
  return [...names].sort();
}

/** Names assigned in a `.env.example`: `NAME=...` at the start of a line. */
export function envNamesListed(text) {
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]).sort();
}

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", ".venv", "__pycache__"]);

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith(".")) out.push(...sourceFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    } else if (name.endsWith(".py") && !name.startsWith("test_") && name !== "conftest.py") {
      out.push(p);
    }
  }
  return out;
}

/** Every server directory, and the names its non-test source reads. */
export function serversAndReads(root = REPO_ROOT) {
  const serversDir = join(root, "servers");
  const result = {};
  for (const name of readdirSync(serversDir).sort()) {
    const dir = join(serversDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const names = new Set();
    for (const file of sourceFiles(dir)) {
      const lang = file.endsWith(".py") ? "py" : "ts";
      for (const n of envNamesRead(readFileSync(file, "utf8"), lang)) names.add(n);
    }
    result[name] = [...names].sort();
  }
  return result;
}

export function check(root = REPO_ROOT) {
  const failures = [];
  const reads = serversAndReads(root);
  for (const [server, read] of Object.entries(reads)) {
    const examplePath = join(root, "servers", server, ".env.example");
    const rel = relative(root, examplePath);
    if (!existsSync(examplePath)) {
      if (read.length > 0) {
        failures.push(`${rel}: missing, and the server reads ${read.join(", ")}`);
      }
      continue;
    }
    const listed = envNamesListed(readFileSync(examplePath, "utf8"));
    for (const n of read.filter((x) => !listed.includes(x))) {
      failures.push(`${rel}: does not list ${n}, which the server reads`);
    }
    for (const n of listed.filter((x) => !read.includes(x))) {
      failures.push(`${rel}: lists ${n}, which nothing in the server reads`);
    }
  }
  return { reads, failures };
}

function main() {
  const { reads, failures } = check();
  const total = Object.values(reads).reduce((acc, r) => acc + r.length, 0);
  if (total === 0) {
    process.stderr.write(
      "check-env-example: found no env reads in any server — the discovery is broken, " +
        "which would otherwise pass vacuously.\n",
    );
    process.exit(1);
  }
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`check-env-example: ${f}\n`);
    process.exit(1);
  }
  const summary = Object.entries(reads)
    .map(([s, r]) => `${s} ${r.length}`)
    .join(", ");
  process.stdout.write(`env-example check ok: ${summary}.\n`);
}

if (isMain(import.meta.url)) main();
