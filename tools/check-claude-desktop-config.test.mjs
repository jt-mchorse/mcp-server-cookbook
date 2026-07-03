// Tests for tools/check-claude-desktop-config.mjs.
//
// Uses node:test (stdlib) so this file is runnable without installing
// vitest or jest. The CI job runs
// `node --test tools/check-claude-desktop-config.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fencedJsonBlocks,
  isClaudeDesktopConfigBlock,
  scanServerReadme,
  listServers,
} from "./check-claude-desktop-config.mjs";

test("fencedJsonBlocks finds ```json and ```jsonc fenced blocks", () => {
  const md = [
    "intro",
    "```json",
    `{"mcpServers": {"x": {"command": "node"}}}`,
    "```",
    "middle",
    "```jsonc",
    `{ "mcpServers": { /* note */ "y": {"command": "python"} } }`,
    "```",
    "```bash",
    "ignored",
    "```",
  ].join("\n");
  const blocks = fencedJsonBlocks(md);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /"mcpServers"/);
  assert.match(blocks[1], /"mcpServers"/);
});

test("fencedJsonBlocks returns empty for markdown with no json fences", () => {
  const md = "no fences here\n\njust prose";
  assert.deepEqual(fencedJsonBlocks(md), []);
});

test("fencedJsonBlocks is CRLF-tolerant — a `\\r\\n` README parses like its LF twin (#79)", () => {
  // A Windows-authored / `core.autocrlf=true` README has `\r\n` line endings.
  // Pre-fix the bare-`\n` regex matched zero blocks on CRLF input, so the
  // checker falsely reported a missing config snippet (exit 1, CI fail).
  const lf = [
    "intro",
    "```json",
    `{"mcpServers": {"x": {"command": "node"}}}`,
    "```",
  ].join("\n");
  const crlf = lf.replace(/\n/g, "\r\n");

  const lfBlocks = fencedJsonBlocks(lf);
  const crlfBlocks = fencedJsonBlocks(crlf);
  assert.equal(lfBlocks.length, 1);
  assert.equal(crlfBlocks.length, 1);
  // The captured body carries the source line endings but the config-shape
  // check is `.includes`-based, so both still resolve as valid config blocks.
  assert.match(crlfBlocks[0], /"mcpServers"/);
  assert.equal(isClaudeDesktopConfigBlock(crlfBlocks[0]), true);
});

test("fencedJsonBlocks tolerates trailing whitespace after the language tag (#79)", () => {
  const md = ["```json  ", `{"mcpServers": {"x": {"command": "node"}}}`, "```"].join(
    "\n",
  );
  assert.equal(fencedJsonBlocks(md).length, 1);
  // The bound `[ \t]*` must not turn ```json into a match for other langs.
  const other = ["```jsonx", `{"mcpServers": 1}`, "```"].join("\n");
  assert.deepEqual(fencedJsonBlocks(other), []);
});

test("scanServerReadme passes on a CRLF README with a valid config block (#79)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crlf-readme-"));
  const readme = path.join(dir, "README.md");
  const md = [
    "# server",
    "```json",
    `{"mcpServers": {"x": {"command": "node", "args": []}}}`,
    "```",
  ].join("\r\n");
  writeFileSync(readme, md);
  const result = scanServerReadme(readme);
  assert.equal(result.ok, true);
});

test("isClaudeDesktopConfigBlock requires both mcpServers and command", () => {
  assert.equal(
    isClaudeDesktopConfigBlock(`{"mcpServers": {"x": {"command": "node"}}}`),
    true,
  );
  // missing "command"
  assert.equal(
    isClaudeDesktopConfigBlock(`{"mcpServers": {"x": {"args": []}}}`),
    false,
  );
  // missing "mcpServers"
  assert.equal(
    isClaudeDesktopConfigBlock(`{"someOther": {"command": "node"}}`),
    false,
  );
  // both missing
  assert.equal(isClaudeDesktopConfigBlock(`{"foo": "bar"}`), false);
});

test("scanServerReadme passes when README has a valid block", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-cdc-pass-"));
  const readmePath = path.join(dir, "README.md");
  writeFileSync(
    readmePath,
    [
      "# Server",
      "",
      "Wire it up:",
      "",
      "```json",
      `{"mcpServers": {"x": {"command": "node", "args": ["server.js"]}}}`,
      "```",
    ].join("\n"),
  );
  const result = scanServerReadme(readmePath);
  assert.equal(result.ok, true);
});

test("scanServerReadme fails when README has prose-only Claude Desktop reference", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-cdc-fail-prose-"));
  const readmePath = path.join(dir, "README.md");
  writeFileSync(
    readmePath,
    [
      "# Server",
      "",
      "Or wire it into Claude Desktop by registering `node dist/server.js`",
      "as the command — no JSON snippet shipped here.",
    ].join("\n"),
  );
  const result = scanServerReadme(readmePath);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no fenced JSON block/);
});

test("scanServerReadme fails when README is missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-cdc-missing-"));
  const readmePath = path.join(dir, "README.md");
  // intentionally not written
  const result = scanServerReadme(readmePath);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing README/);
});

test("scanServerReadme fails when JSON block is present but lacks mcpServers key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-cdc-wrong-block-"));
  const readmePath = path.join(dir, "README.md");
  writeFileSync(
    readmePath,
    [
      "# Server",
      "",
      "```json",
      `{"someTool": {"command": "node"}}`,
      "```",
    ].join("\n"),
  );
  const result = scanServerReadme(readmePath);
  assert.equal(result.ok, false);
});

test("listServers returns sorted directory names under serversDir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "check-cdc-listservers-"));
  mkdirSync(path.join(root, "zeta"));
  mkdirSync(path.join(root, "alpha"));
  mkdirSync(path.join(root, "beta"));
  writeFileSync(path.join(root, "not-a-dir.md"), "ignored");
  assert.deepEqual(listServers(root), ["alpha", "beta", "zeta"]);
});

test("listServers returns empty array on missing dir", () => {
  assert.deepEqual(listServers("/no/such/path/at/all"), []);
});
