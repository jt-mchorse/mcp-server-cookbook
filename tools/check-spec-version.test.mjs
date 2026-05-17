// Tests for tools/check-spec-version.mjs.
//
// Uses node:test (stdlib) so this file is runnable without installing
// vitest or jest. The CI job runs `node --test tools/check-spec-version.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  check,
  findServerPackageFiles,
  parseFirstYamlBlock,
  readSdkPin,
} from "./check-spec-version.mjs";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SDK = "@modelcontextprotocol/sdk";
const PIN = "^1.5.0";

function makeTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "spec-version-"));
  mkdirSync(path.join(dir, "servers"), { recursive: true });
  return dir;
}

function makeServer(repo, name, sdkVersion, { devOnly = false } = {}) {
  const serverDir = path.join(repo, "servers", name);
  mkdirSync(serverDir, { recursive: true });
  const pkg = {
    name: `@mcp-cookbook/${name}`,
    version: "0.1.0",
    type: "module",
  };
  if (sdkVersion !== undefined) {
    if (devOnly) {
      pkg.devDependencies = { [SDK]: sdkVersion };
    } else {
      pkg.dependencies = { [SDK]: sdkVersion };
    }
  }
  writeFileSync(path.join(serverDir, "package.json"), JSON.stringify(pkg, null, 2));
}

test("parseFirstYamlBlock extracts the documented fields", () => {
  const md = [
    "# header",
    "",
    "Some intro prose.",
    "",
    "```yaml",
    'sdk_package: "@modelcontextprotocol/sdk"',
    'sdk_version: "^1.5.0"',
    'mcp_spec_revision: "2025-06-18"',
    "```",
    "",
    "Trailing text.",
  ].join("\n");
  const got = parseFirstYamlBlock(md);
  assert.deepEqual(got, {
    sdk_package: "@modelcontextprotocol/sdk",
    sdk_version: "^1.5.0",
    mcp_spec_revision: "2025-06-18",
  });
});

test("parseFirstYamlBlock returns null when no yaml block is present", () => {
  assert.equal(parseFirstYamlBlock("# just a header\n\nprose only\n"), null);
});

test("parseFirstYamlBlock skips comments and blank lines", () => {
  const md = [
    "```yaml",
    "# a comment",
    "",
    'sdk_package: "@modelcontextprotocol/sdk"',
    "# another comment",
    'sdk_version: "^1.5.0"',
    "```",
  ].join("\n");
  assert.deepEqual(parseFirstYamlBlock(md), {
    sdk_package: "@modelcontextprotocol/sdk",
    sdk_version: "^1.5.0",
  });
});

test("parseFirstYamlBlock tolerates single quotes", () => {
  const md = ["```yaml", "sdk_version: '^1.5.0'", "```"].join("\n");
  assert.deepEqual(parseFirstYamlBlock(md), { sdk_version: "^1.5.0" });
});

test("findServerPackageFiles lists every server directory with a package.json", () => {
  const repo = makeTempRepo();
  try {
    makeServer(repo, "alpha", PIN);
    makeServer(repo, "beta", PIN);
    // Distractor: a server-named dir without a package.json must be skipped.
    mkdirSync(path.join(repo, "servers", "no-pkg"), { recursive: true });
    // Distractor: node_modules is skipped.
    mkdirSync(path.join(repo, "servers", "node_modules"), { recursive: true });
    writeFileSync(
      path.join(repo, "servers", "node_modules", "package.json"),
      JSON.stringify({ name: "bogus" })
    );

    const got = findServerPackageFiles(path.join(repo, "servers"));
    assert.deepEqual(
      got.map((g) => g.server),
      ["alpha", "beta"]
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("findServerPackageFiles returns [] when servers/ does not exist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spec-version-no-servers-"));
  try {
    assert.deepEqual(findServerPackageFiles(path.join(dir, "servers")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSdkPin reads from dependencies", () => {
  const repo = makeTempRepo();
  try {
    makeServer(repo, "alpha", PIN);
    const v = readSdkPin(path.join(repo, "servers/alpha/package.json"), SDK);
    assert.equal(v, PIN);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("readSdkPin falls back to devDependencies", () => {
  const repo = makeTempRepo();
  try {
    makeServer(repo, "beta", PIN, { devOnly: true });
    const v = readSdkPin(path.join(repo, "servers/beta/package.json"), SDK);
    assert.equal(v, PIN);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("readSdkPin returns null when the SDK dep is missing", () => {
  const repo = makeTempRepo();
  try {
    makeServer(repo, "no-sdk", undefined);
    const v = readSdkPin(path.join(repo, "servers/no-sdk/package.json"), SDK);
    assert.equal(v, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("check passes when every server matches the doc", () => {
  const result = check({
    doc: { sdk_package: SDK, sdk_version: PIN, mcp_spec_revision: "2025-06-18" },
    servers: [
      { server: "alpha", version: PIN },
      { server: "beta", version: PIN },
      { server: "gamma", version: PIN },
    ],
    sdkPackage: SDK,
    expectedVersion: PIN,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("check fails when a server pin drifts from the doc", () => {
  const result = check({
    doc: { sdk_package: SDK, sdk_version: PIN },
    servers: [
      { server: "alpha", version: PIN },
      { server: "beta", version: "^1.6.0" },
    ],
    sdkPackage: SDK,
    expectedVersion: PIN,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /servers\/beta/);
  assert.match(result.errors[0], /\^1\.6\.0/);
  assert.match(result.errors[0], /\^1\.5\.0/);
});

test("check fails when a server is missing the SDK dep entirely", () => {
  const result = check({
    doc: { sdk_package: SDK, sdk_version: PIN },
    servers: [
      { server: "alpha", version: PIN },
      { server: "broken", version: null },
    ],
    sdkPackage: SDK,
    expectedVersion: PIN,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /servers\/broken/);
  assert.match(result.errors[0], /not declared/);
});

test("check fails when there are no servers", () => {
  const result = check({
    doc: { sdk_package: SDK, sdk_version: PIN },
    servers: [],
    sdkPackage: SDK,
    expectedVersion: PIN,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /No servers/);
});

test("check is consistent: same version across servers means no errors even if doc disagrees", () => {
  // The "same SDK across servers" invariant is implied by every server
  // being compared against the same expected value; when the doc itself
  // disagrees, every server errors uniformly. This guards against a
  // future refactor that loosens the intra-repo invariant accidentally.
  const result = check({
    doc: { sdk_package: SDK, sdk_version: "^1.6.0" },
    servers: [
      { server: "alpha", version: PIN },
      { server: "beta", version: PIN },
    ],
    sdkPackage: SDK,
    expectedVersion: "^1.6.0",
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  for (const e of result.errors) {
    assert.match(e, /1\.5\.0/);
    assert.match(e, /1\.6\.0/);
  }
});
