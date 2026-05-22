// Tests for tools/check-capture-demo.mjs.
//
// Uses node:test (stdlib) — no vitest install, no test-runner deps.
// CI runs `node --test tools/check-capture-demo.test.mjs` after
// `node tools/check-capture-demo.mjs`. These tests cover the pure
// assertion logic against synthetic stdout; the integration that
// actually spawns `tools/capture_demo.sh` is the `check-capture-demo.mjs`
// CLI step itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  REQUIRED_PATTERNS,
  FORBIDDEN_LITERALS,
  TOKEN_SENTINEL,
  CaptureDemoAssertionError,
  assertCaptureOutput,
  SCRIPT,
  REPO_ROOT,
} from "./check-capture-demo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Synthesize a stdout that satisfies every REQUIRED_PATTERNS substring.
 * Used as the baseline against which tamper assertions can flip one
 * required line at a time.
 */
function goodStdout() {
  return REQUIRED_PATTERNS.join("\n") + "\n";
}

test("assertCaptureOutput accepts a stdout that contains every REQUIRED_PATTERNS substring", () => {
  assert.doesNotThrow(() => assertCaptureOutput(goodStdout()));
});

test("assertCaptureOutput throws if any single REQUIRED_PATTERNS substring is missing", () => {
  for (const pat of REQUIRED_PATTERNS) {
    // Remove just this one pattern; keep the rest intact.
    const tampered = REQUIRED_PATTERNS.filter((p) => p !== pat).join("\n") + "\n";
    let err;
    try {
      assertCaptureOutput(tampered);
    } catch (e) {
      err = e;
    }
    assert.ok(err, `expected throw when ${JSON.stringify(pat)} was missing`);
    assert.ok(err instanceof CaptureDemoAssertionError);
    assert.equal(err.kind, "missing-required");
    assert.equal(err.pattern, pat);
    assert.match(err.message, new RegExp("missing required line"));
  }
});

test("assertCaptureOutput throws if the token sentinel appears anywhere in stdout", () => {
  const stdout = goodStdout() + "\noops leaked: " + TOKEN_SENTINEL + "\n";
  let err;
  try {
    assertCaptureOutput(stdout);
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.ok(err instanceof CaptureDemoAssertionError);
  assert.equal(err.kind, "forbidden-present");
  assert.equal(err.pattern, TOKEN_SENTINEL);
  assert.match(err.message, /D-007 contract violation/);
});

test("assertCaptureOutput fails fast on the first missing required pattern (not the last)", () => {
  // Drop the very first pattern only; the remaining trail of patterns is
  // intact. The thrown error should name the FIRST missing pattern, not
  // any later one — so a regression that breaks the first surface fails
  // with the most useful diagnostic.
  const tampered = REQUIRED_PATTERNS.slice(1).join("\n") + "\n";
  let err;
  try {
    assertCaptureOutput(tampered);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof CaptureDemoAssertionError);
  assert.equal(err.pattern, REQUIRED_PATTERNS[0]);
});

test("REQUIRED_PATTERNS covers all three surfaces' banners explicitly", () => {
  // Anchor: a future edit that reorders surfaces or renames banners has
  // to update both the script AND this test, so the contract stays
  // grep-able from one place.
  const banners = [
    "═══ 1/3 · postgres-readonly · SQL guard",
    "═══ 2/3 · filesystem-sandbox-py · path resolution",
    "═══ 3/3 · github-gists · token redaction at error boundaries",
  ];
  for (const banner of banners) {
    const found = REQUIRED_PATTERNS.some((p) => p.startsWith(banner));
    assert.ok(found, `no REQUIRED_PATTERNS entry starts with ${JSON.stringify(banner)}`);
  }
});

test("REQUIRED_PATTERNS pins the D-NNN annotation on each surface banner", () => {
  // The whole point of surfacing the D-NNN in the banner is that a
  // reviewer / viewer immediately knows which decision the demo
  // is exercising. If a future cleanup drops "(D-004 ...)" from the
  // banner, this test catches it.
  const surface1 = REQUIRED_PATTERNS.find((p) => p.includes("1/3 · postgres-readonly"));
  const surface2 = REQUIRED_PATTERNS.find((p) => p.includes("2/3 · filesystem-sandbox-py"));
  const surface3 = REQUIRED_PATTERNS.find((p) => p.includes("3/3 · github-gists"));
  assert.match(surface1, /D-004/);
  assert.match(surface2, /D-005, D-006/);
  assert.match(surface3, /D-007/);
});

test("FORBIDDEN_LITERALS contains exactly the token sentinel", () => {
  // Hard-pin so a loose edit that drops the sentinel from the list (and
  // therefore silently weakens the D-007 check) fails this test.
  assert.deepEqual(FORBIDDEN_LITERALS, [TOKEN_SENTINEL]);
});

test("TOKEN_SENTINEL matches the literal hard-coded in tools/capture_demo.sh", () => {
  // Cross-file invariant: the asserter's sentinel and the script's
  // sentinel must agree, otherwise the "is the literal absent from
  // stdout?" check is meaningless. Read the script as text and confirm.
  const scriptSrc = readFileSync(SCRIPT, "utf8");
  assert.ok(
    scriptSrc.includes(TOKEN_SENTINEL),
    `${SCRIPT} does not contain the TOKEN_SENTINEL literal; check-capture-demo.mjs's check is no-op`,
  );
});

test("script file exists and is executable", () => {
  // Don't actually run it here (that's the CLI step's job); just verify
  // the path resolves on disk. Catches a future move/rename of the
  // script.
  const scriptRel = path.relative(REPO_ROOT, SCRIPT);
  assert.equal(scriptRel, path.join("tools", "capture_demo.sh"));
});
