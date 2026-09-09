// Unit tests for `check-config-port-parity.mjs` (#168).
//
// The check itself is a set comparison, so these tests are about the two things
// that can make a set comparison lie: what counts as a read, and whether the
// comparison is looking at anything at all.

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { PORTED_PAIR, check, settingsRead } from "./check-config-port-parity.mjs";

function treeWith(tsCode, pyCode) {
  const root = mkdtempSync(join(tmpdir(), "port-parity-"));
  for (const [port, rel] of Object.entries(PORTED_PAIR)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, port === "ts" ? tsCode : pyCode, "utf8");
  }
  return root;
}

function withTree(tsCode, pyCode, fn) {
  const root = treeWith(tsCode, pyCode);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TS_THREE = `
export function readConfig(env) {
  const raw = env.MCP_FS_SANDBOX_ALLOWLIST ?? "";
  const ro = env.MCP_FS_SANDBOX_READ_ONLY ?? "";
  const max = env.MCP_FS_SANDBOX_MAX_BYTES;
  return { raw, ro, max };
}
`;

const PY_THREE = `
def read_config(e):
    raw = e.get("MCP_FS_SANDBOX_ALLOWLIST", "")
    ro = e.get("MCP_FS_SANDBOX_READ_ONLY", "")
    mx = e.get("MCP_FS_SANDBOX_MAX_BYTES", "")
    return raw, ro, mx
`;

test("agreeing ports pass", () => {
  withTree(TS_THREE, PY_THREE, (root) => {
    const { read, failures } = check(root);
    assert.deepEqual(failures, []);
    assert.equal(read.ts.length, 3);
    assert.deepEqual(read.ts, read.py);
  });
});

test("a setting only the TypeScript port reads is reported", () => {
  const ts = TS_THREE + '\nexport const label = (env) => env.MCP_FS_SANDBOX_AUDIT_LABEL ?? "d";\n';
  withTree(ts, PY_THREE, (root) => {
    const { failures } = check(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /MCP_FS_SANDBOX_AUDIT_LABEL.*TypeScript port but not by the Python/);
  });
});

test("a setting only the Python port reads is reported", () => {
  const py = PY_THREE + '\ndef label(e):\n    return e.get("MCP_FS_SANDBOX_AUDIT_LABEL", "d")\n';
  withTree(TS_THREE, py, (root) => {
    const { failures } = check(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /MCP_FS_SANDBOX_AUDIT_LABEL.*Python port but not by the TypeScript/);
  });
});

test("both directions are reported together, not just the first", () => {
  // A check that returned early would name one and hide the other, and a
  // divergent pair usually has both halves.
  const ts = TS_THREE + '\nexport const a = (env) => env.MCP_FS_SANDBOX_ONLY_TS ?? "d";\n';
  const py = PY_THREE + '\ndef b(e):\n    return e.get("MCP_FS_SANDBOX_ONLY_PY", "d")\n';
  withTree(ts, py, (root) => {
    const { failures } = check(root);
    assert.equal(failures.length, 2);
    assert.ok(failures.some((f) => /ONLY_TS/.test(f)));
    assert.ok(failures.some((f) => /ONLY_PY/.test(f)));
  });
});

test("a setting named only in a comment is not a read", () => {
  // The false-hit shape a grep would have: both config modules open with a
  // paragraph naming all three settings. If prose counted, the check would
  // pass for the wrong reason -- and would keep passing after a port dropped a
  // real read but kept the docstring.
  const ts = TS_THREE + "\n// MCP_FS_SANDBOX_AUDIT_LABEL is documented but not read\n";
  const py = PY_THREE + '\n"""MCP_FS_SANDBOX_AUDIT_LABEL is documented but not read."""\n';
  withTree(ts, py, (root) => {
    assert.deepEqual(check(root).failures, []);
  });
  assert.deepEqual(settingsRead("// MCP_FS_SANDBOX_X\n"), []);
  assert.deepEqual(settingsRead("# MCP_FS_SANDBOX_X\n"), []);
  assert.deepEqual(settingsRead('"""MCP_FS_SANDBOX_X"""\n'), []);
  assert.deepEqual(settingsRead("/* MCP_FS_SANDBOX_X */\n"), []);
});

test("the matcher is access-syntax agnostic, which is the point", () => {
  // The two ports spell the access three different ways. A matcher keyed on
  // syntax would need to know both languages; this one is keyed on the NAME.
  assert.deepEqual(settingsRead('env.MCP_FS_SANDBOX_A;'), ["MCP_FS_SANDBOX_A"]);
  assert.deepEqual(settingsRead('env["MCP_FS_SANDBOX_A"];'), ["MCP_FS_SANDBOX_A"]);
  assert.deepEqual(settingsRead('e.get("MCP_FS_SANDBOX_A", "")'), ["MCP_FS_SANDBOX_A"]);
  assert.deepEqual(settingsRead("os.environ['MCP_FS_SANDBOX_A']"), ["MCP_FS_SANDBOX_A"]);
});

test("a missing half of the pair is reported, not silently skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "port-parity-"));
  try {
    const file = join(root, PORTED_PAIR.ts);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, TS_THREE, "utf8");
    const { failures } = check(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /missing; the ported pair is defined by these two files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree passes, and reads a non-trivial number of settings", () => {
  // Anti-vacuous against the repo itself: a matcher that stopped matching would
  // report zero settings and zero divergences, which reads exactly like
  // agreement. The `main()` path exits 2 on zero for the same reason.
  const { read, failures } = check();
  assert.deepEqual(failures, []);
  assert.ok(read.ts.length >= 3, `expected >= 3 settings, got ${JSON.stringify(read.ts)}`);
  assert.ok(read.ts.includes("MCP_FS_SANDBOX_ALLOWLIST"));
  assert.ok(read.ts.includes("MCP_FS_SANDBOX_READ_ONLY"));
  assert.ok(read.ts.includes("MCP_FS_SANDBOX_MAX_BYTES"));
});
