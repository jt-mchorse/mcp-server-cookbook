// Tests for tools/check-architecture-doc.mjs.
//
// Uses node:test (stdlib) so this file is runnable without installing
// vitest or jest. The CI job runs `node --test tools/check-architecture-doc.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  archServerRefs,
  findStalePhrases,
  STALE_PHRASES,
} from "./check-architecture-doc.mjs";

test("archServerRefs collects unique servers/<name> references in path form", () => {
  const md = [
    "see `servers/postgres-readonly/README.md` for details",
    "diagram has `│   ├── filesystem-sandbox/`",
    "and `servers/github-gists/` again",
    "  and once more `servers/postgres-readonly/` (dup)",
  ].join("\n");
  assert.deepEqual(archServerRefs(md), [
    "github-gists",
    "postgres-readonly",
  ]);
});

test("archServerRefs accepts hyphenated and numeric server names", () => {
  const md = "servers/filesystem-sandbox-py and servers/foo-bar-99";
  assert.deepEqual(archServerRefs(md), ["filesystem-sandbox-py", "foo-bar-99"]);
});

test("archServerRefs rejects identifiers without the leading `servers/`", () => {
  const md = "this mentions `postgres-readonly` and `filesystem-sandbox` but not as paths";
  assert.deepEqual(archServerRefs(md), []);
});

test("STALE_PHRASES contains the four shapes of #22 drift, in declared order", () => {
  // Hard-pin the set in the test so a future loose edit of the checker
  // can't silently drop one of the banned phrases.
  assert.deepEqual(STALE_PHRASES, [
    "api-with-auth",
    "pending issue",
    "pending (not yet filed)",
    "this PR",
  ]);
});

test("findStalePhrases returns empty for clean markdown", () => {
  const md = [
    "# Architecture",
    "",
    "five servers ship: postgres-readonly, filesystem-sandbox, ",
    "filesystem-sandbox-py, github-gists, internal-tools-bridge.",
  ].join("\n");
  assert.deepEqual(findStalePhrases(md), []);
});

test("findStalePhrases catches each banned phrase individually", () => {
  for (const phrase of STALE_PHRASES) {
    const md = `clean prose around the phrase ${phrase} and more after`;
    const hits = findStalePhrases(md);
    assert.equal(hits.length, 1, `expected exactly one hit for "${phrase}"`);
    assert.equal(hits[0].phrase, phrase);
    assert.ok(hits[0].index > 0, `expected non-zero index for "${phrase}"`);
  }
});

test("findStalePhrases catches multiple phrases in the same source", () => {
  const md = [
    "this PR ships `api-with-auth` as a pending issue tracked as",
    "pending (not yet filed) until later.",
  ].join("\n");
  const hits = findStalePhrases(md);
  const phrases = hits.map((h) => h.phrase).sort();
  assert.deepEqual(phrases, [...STALE_PHRASES].sort());
});

test("checker integration: docs/architecture.md is currently clean", async () => {
  // Run the script as a subprocess so we exercise main() end-to-end
  // against the real doc, not a synthetic fixture. This guards against
  // a regression where someone edits architecture.md and forgets to
  // re-run the check locally.
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const path = (await import("node:path")).default;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(__dirname, "check-architecture-doc.mjs");

  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `check-architecture-doc.mjs failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  assert.match(result.stdout, /check ok:/);
});
