#!/usr/bin/env node
//
// Verify every servers/<name>/package.json pins
// @modelcontextprotocol/sdk to the version declared in
// docs/spec-version.md.
//
// Two invariants:
//   1. Recorded-vs-actual: each server's pin === the doc's pin.
//   2. Intra-repo consistency: every server pins the same value.
//
// The script is dep-free Node (stdlib only) so it runs in CI without
// an install step. Exit codes:
//   0 — all servers match the doc
//   1 — drift detected; one or more servers fail
//   2 — bad input (missing doc, malformed YAML block, no servers)
//
// The YAML parser here is intentionally tiny: the doc owns a
// fixed-shape five-line block, so we parse key:value lines rather
// than pulling in a full YAML library. If the doc grows a more
// complex structure, swap in `yaml` from npm and update the tests.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const DOC_PATH = path.join(REPO_ROOT, "docs/spec-version.md");
const SERVERS_DIR = path.join(REPO_ROOT, "servers");

/**
 * Parse the first ```yaml fenced block in `markdown` into a
 * `{ key: value }` record. Strips surrounding quotes from string
 * values. Returns null if no block was found.
 */
export function parseFirstYamlBlock(markdown) {
  const lines = markdown.split(/\r?\n/);
  let inBlock = false;
  const collected = [];
  for (const line of lines) {
    if (!inBlock && line.trim() === "```yaml") {
      inBlock = true;
      continue;
    }
    if (inBlock && line.trim() === "```") {
      const out = {};
      for (const raw of collected) {
        const stripped = raw.replace(/^\s+/, "");
        if (stripped.length === 0 || stripped.startsWith("#")) continue;
        const m = stripped.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (!m) continue;
        let value = m[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        out[m[1]] = value;
      }
      return out;
    }
    if (inBlock) collected.push(line);
  }
  return null;
}

/**
 * Find every `servers/<name>/package.json` under `serversDir`. Skips
 * `node_modules`, `dist`, and any hidden directory.
 */
export function findServerPackageFiles(serversDir) {
  let entries;
  try {
    entries = readdirSync(serversDir);
  } catch (_e) {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules" || name === "dist") continue;
    const fullPath = path.join(serversDir, name);
    let s;
    try {
      s = statSync(fullPath);
    } catch (_e) {
      continue;
    }
    if (!s.isDirectory()) continue;
    const pkgJson = path.join(fullPath, "package.json");
    try {
      statSync(pkgJson);
    } catch (_e) {
      continue;
    }
    out.push({ server: name, packageJsonPath: pkgJson });
  }
  out.sort((a, b) => a.server.localeCompare(b.server));
  return out;
}

/**
 * Read `package.json` and return the declared SDK version (or null
 * if the dep is missing).
 */
export function readSdkPin(packageJsonPath, sdkPackage) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const deps = pkg.dependencies ?? {};
  const devDeps = pkg.devDependencies ?? {};
  return deps[sdkPackage] ?? devDeps[sdkPackage] ?? null;
}

/**
 * Pure-function check. Returns `{ ok, errors }` so this is callable
 * from tests without process-level state.
 */
export function check({ doc, servers, sdkPackage, expectedVersion }) {
  const errors = [];

  if (servers.length === 0) {
    errors.push(
      `No servers found under servers/. Either the directory is empty or the layout changed.`
    );
    return { ok: false, errors };
  }

  // Recorded-vs-actual: every server must declare the expected version.
  // Intra-repo consistency falls out for free because every server is
  // compared against the same expected string.
  const observed = new Map();
  for (const { server, version } of servers) {
    observed.set(server, version);
    if (version === null) {
      errors.push(
        `servers/${server}/package.json: ${sdkPackage} is not declared. ` +
          `Expected "${expectedVersion}" per docs/spec-version.md.`
      );
      continue;
    }
    if (version !== expectedVersion) {
      errors.push(
        `servers/${server}/package.json: ${sdkPackage}="${version}" ` +
          `does not match the pinned "${expectedVersion}" in docs/spec-version.md. ` +
          `Either bump the server or update the doc (see "Upstream spec verification" in docs/spec-version.md for the procedure).`
      );
    }
  }

  // Belt-and-braces: even if the doc parse succeeded, surface the doc
  // metadata in the success path so CI logs show what was enforced.
  return {
    ok: errors.length === 0,
    errors,
    observed: Object.fromEntries(observed),
    doc,
  };
}

async function main() {
  let markdown;
  try {
    markdown = readFileSync(DOC_PATH, "utf8");
  } catch (_e) {
    console.error(
      `error: docs/spec-version.md not found at ${DOC_PATH}. The CI check requires this file as the source of truth.`
    );
    process.exit(2);
  }

  const doc = parseFirstYamlBlock(markdown);
  if (doc === null) {
    console.error(
      `error: no fenced \`\`\`yaml block found in docs/spec-version.md. The block format is documented inline in that file.`
    );
    process.exit(2);
  }
  const sdkPackage = doc.sdk_package;
  const expectedVersion = doc.sdk_version;
  if (!sdkPackage || !expectedVersion) {
    console.error(
      `error: docs/spec-version.md yaml block missing required keys ` +
        `sdk_package and/or sdk_version. Got: ${JSON.stringify(doc)}.`
    );
    process.exit(2);
  }

  const entries = findServerPackageFiles(SERVERS_DIR);
  const servers = entries.map(({ server, packageJsonPath }) => ({
    server,
    version: readSdkPin(packageJsonPath, sdkPackage),
  }));

  const result = check({ doc, servers, sdkPackage, expectedVersion });

  if (result.ok) {
    console.log(
      `spec-version: OK — ${servers.length} server(s) pin ` +
        `${sdkPackage}@${expectedVersion} ` +
        `(MCP spec revision ${doc.mcp_spec_revision ?? "unknown"}).`
    );
    for (const { server, version } of servers) {
      console.log(`  servers/${server}: ${version}`);
    }
    process.exit(0);
  }
  for (const err of result.errors) console.error(`error: ${err}`);
  process.exit(1);
}

// Only run main when executed directly, not when imported by tests.
const isDirectInvocation =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main();
}
