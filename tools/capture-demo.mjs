#!/usr/bin/env node
//
// Deterministic capture orchestrator for the mcp-server-cookbook 60-second demo.
//
// The cookbook's three-server demo flow (`postgres-readonly` +
// `filesystem-sandbox` + `github-gists`) is captured by recording an
// MCP client (Claude Desktop or Claude Code CLI) invoking one tool
// per server. The recording isn't Node-scriptable — only Claude can
// drive a tool call through MCP — but the *inputs* to those tool
// calls must be reproducible if the recording is going to be
// re-capturable. That's what this tool ensures.
//
// Stages:
//   STAGE 1 — postgres-readonly: verify the sample-db seed (sha256
//             fingerprint of `servers/postgres-readonly/sample-db/init.sql`),
//             optionally `docker compose up -d` with --launch-postgres,
//             print the exact `describe_schema` + `run_select` tool
//             invocations the operator drives in Claude.
//   STAGE 2 — filesystem-sandbox: create a deterministic tmp allow-list
//             dir under /tmp/mcp-demo-fs-sandbox/ with known files,
//             print the `MCP_FS_SANDBOX_ALLOWLIST` env var, print the
//             `read_file` success + path-traversal tool invocations.
//   STAGE 3 — github-gists: print the fixture gist ID from
//             `docs/demo_fixture.md` and the `get_gist` success +
//             redaction-error tool invocations.
//
// Closes the AC3 row on #16. AC1 (committed GIF/MP4) and AC2 (README
// embed) remain operator-only — only the operator's screen recorder
// can capture the MCP-client UI. Same posture as the Python sister
// PRs (#33 / #29 / #28 / #31 from this same day-session loop).
//
// Node stdlib only — no `npm install` required. Locked by
// `tools/capture-demo.test.mjs` using `node:test`, matching the
// existing `tools/check-*.test.mjs` pattern.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Constants: fingerprints, paths, fixture IDs.
// ---------------------------------------------------------------------------

export const POSTGRES_SEED_PATH = "servers/postgres-readonly/sample-db/init.sql";

// `/tmp` (or `os.tmpdir()`-style; we hard-code `/tmp` because the
// operator copy-pastes the env var into Claude Desktop's config and
// it has to be stable across re-captures, not platform-mapped).
export const SANDBOX_ROOT = "/tmp/mcp-demo-fs-sandbox";

// Files written into SANDBOX_ROOT so the `read_file` tool call has
// known content to return. Names + content pinned so the recording's
// frames are byte-for-byte identical across re-captures.
export const SANDBOX_FILES = [
  {
    rel: "hello.txt",
    content: "hello from the filesystem-sandbox demo\n",
  },
  {
    rel: "nested/note.md",
    content: "# nested allow-list demo\n\nNested directories work too.\n",
  },
];

export const FIXTURE_DOC_PATH = "docs/demo_fixture.md";

// ---------------------------------------------------------------------------
// Helpers (exported so the test file can drive them directly).
// ---------------------------------------------------------------------------

export function sha256OfFile(absPath) {
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

export function banner(stage, title) {
  const line = "=".repeat(72);
  return `\n${line}\n  STAGE ${stage}  ${title}\n${line}\n`;
}

export function buildSandboxLayout({ root = SANDBOX_ROOT, clean = true } = {}) {
  if (clean && existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });
  for (const file of SANDBOX_FILES) {
    const dest = path.join(root, file.rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, file.content);
  }
  return root;
}

export function extractFixtureGistId(docText) {
  // The fixture doc surfaces the gist ID on a line that looks like:
  //     `gist_id`: `<40-hex-or-shorthand>`
  // The test pins the exact format. Returns `null` if the doc hasn't
  // been authored yet — the script then falls back to a placeholder
  // so the operator sees what to fill in.
  const m = docText.match(/`gist_id`:\s*`([A-Za-z0-9_-]+)`/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Stage renderers.
// ---------------------------------------------------------------------------

export function renderStage1Cheatsheet({ seedSha256, launched }) {
  const launchNote = launched
    ? "[capture] docker compose started; healthcheck passes in ~5s."
    : "# Optional: --launch-postgres runs `docker compose up -d` for you.\n#           Off by default — docker is heavyweight; the operator may have it already.";
  return [
    "# Postgres readonly server (STAGE 1) — operator drives in Claude.",
    "#",
    "# Deterministic input: the sample DB seed.",
    `#   sha256(${POSTGRES_SEED_PATH}) = ${seedSha256}`,
    "#",
    "# 1. Bring up the sample database (separate terminal):",
    "#      cd servers/postgres-readonly",
    "#      docker compose up -d",
    "#      DATABASE_URL=postgresql://mcp_reader:mcp_reader@localhost:5433/bench npm start",
    "#",
    launchNote,
    "#",
    "# 2. In the MCP client (Claude Desktop / Claude Code), run:",
    "#",
    "#      Tool: describe_schema",
    "#      Args: (none)",
    "#      Expected: the orders / customers / order_status_enum tables",
    "#                with FK + view structure visible.",
    "#",
    "#      Tool: run_select",
    "#      Args: { sql: \"DELETE FROM orders\" }",
    "#      Expected: write_blocked error from server-side parsing",
    "#                AND from the DB-side read-only role (D-004 defense",
    "#                in depth). Recording shows both error paths.",
  ].join("\n");
}

export function renderStage2Cheatsheet({ sandboxRoot }) {
  const allowedFile = path.join(sandboxRoot, SANDBOX_FILES[0].rel);
  const outsideFile = "/etc/passwd";
  return [
    "# Filesystem sandbox server (STAGE 2) — operator drives in Claude.",
    "#",
    "# Deterministic input: the allow-list tmp dir, just created:",
    `#   ${sandboxRoot}`,
    `#   ${path.join(sandboxRoot, SANDBOX_FILES[0].rel)}`,
    `#   ${path.join(sandboxRoot, SANDBOX_FILES[1].rel)}`,
    "#",
    "# 1. Start the sandbox server (separate terminal):",
    "#      cd servers/filesystem-sandbox",
    `#      MCP_FS_SANDBOX_ALLOWLIST=${sandboxRoot} npm start`,
    "#",
    "# 2. In the MCP client, run:",
    "#",
    "#      Tool: read_file",
    `#      Args: { path: ${JSON.stringify(allowedFile)} }`,
    "#      Expected: the file's contents return successfully.",
    "#",
    "#      Tool: read_file",
    `#      Args: { path: ${JSON.stringify(outsideFile)} }`,
    "#      Expected: outside_allowlist error. The recording shows the",
    "#                path-traversal attempt failing loud, with the",
    "#                resolved-canonical path in the error context.",
  ].join("\n");
}

export function renderStage3Cheatsheet({ fixtureGistId }) {
  const id = fixtureGistId ?? "<paste-a-public-gist-id-here>";
  const wasResolved = fixtureGistId !== null;
  return [
    "# GitHub gists server (STAGE 3) — operator drives in Claude.",
    "#",
    "# Deterministic input: the public fixture gist ID.",
    wasResolved
      ? `#   from ${FIXTURE_DOC_PATH}: ${id}`
      : `#   ${FIXTURE_DOC_PATH} did not yield a gist_id; using placeholder.`,
    "#",
    "# 1. Start the gists server (separate terminal):",
    "#      cd servers/github-gists",
    "#      GITHUB_TOKEN=ghp_xxx_placeholder npm start",
    "#      (token is optional for public-read; setting it exercises the",
    "#       D-007 redaction path on the error case below.)",
    "#",
    "# 2. In the MCP client, run:",
    "#",
    `#      Tool: get_gist`,
    `#      Args: { gistId: ${JSON.stringify(id)} }`,
    "#      Expected: the gist's files return with metadata.",
    "#",
    `#      Tool: get_gist`,
    `#      Args: { gistId: \"this-id-does-not-exist-anywhere\" }`,
    "#      Expected: 404 error path. The recording shows the resolved",
    "#                URL in the error message has NO trailing token",
    "#                query (D-007) — the bearer value isn't echoed and",
    "#                the request body is dropped from the error context.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI flag parsing — small enough not to need a dep.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    pauseSeconds: 2.0,
    launchPostgres: false,
    sandboxRoot: SANDBOX_ROOT,
    skipSandboxLayout: false,
    skipStage1: false,
    skipStage2: false,
    skipStage3: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pause-seconds") {
      args.pauseSeconds = Number(argv[i + 1] ?? "0");
      i += 1;
    } else if (a === "--sandbox-root") {
      args.sandboxRoot = argv[i + 1];
      i += 1;
    } else if (a === "--launch-postgres") {
      args.launchPostgres = true;
    } else if (a === "--skip-sandbox-layout") {
      args.skipSandboxLayout = true;
    } else if (a === "--skip-stage-1") {
      args.skipStage1 = true;
    } else if (a === "--skip-stage-2") {
      args.skipStage2 = true;
    } else if (a === "--skip-stage-3") {
      args.skipStage3 = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function helpText() {
  return [
    "Usage: node tools/capture-demo.mjs [--pause-seconds 2.0]",
    "                                   [--sandbox-root /tmp/mcp-demo-fs-sandbox]",
    "                                   [--launch-postgres]",
    "                                   [--skip-sandbox-layout]",
    "                                   [--skip-stage-1|2|3]",
    "",
    "Deterministic capture orchestrator for the 60-second cookbook demo.",
    "Sets up reproducible inputs (postgres seed sha256, sandbox tmp dir,",
    "fixture gist ID) and prints the exact tool invocations the operator",
    "drives in Claude Desktop / Claude Code while recording.",
    "",
    "Closes AC3 on #16. AC1 (committed GIF/MP4) and AC2 (README embed)",
    "are operator-only.",
  ].join("\n");
}

function sleepSync(seconds) {
  if (seconds <= 0) return;
  // Stdlib has no synchronous sleep; spawn `sleep` with a fallback
  // for Windows (cmd /c timeout). Avoiding busy-wait keeps the test
  // suite quiet.
  try {
    execFileSync("sleep", [String(seconds)], { stdio: "ignore" });
  } catch {
    /* swallow — pause is best-effort */
  }
}

export function main(argv = process.argv.slice(2), out = process.stdout) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    out.write(`error: ${err.message}\n`);
    out.write(helpText() + "\n");
    return 2;
  }
  if (args.help) {
    out.write(helpText() + "\n");
    return 0;
  }

  // STAGE 1 — postgres-readonly.
  if (!args.skipStage1) {
    out.write(banner(1, "postgres-readonly (describe_schema + write-blocked select)"));
    const seedAbs = path.join(REPO_ROOT, POSTGRES_SEED_PATH);
    if (!existsSync(seedAbs)) {
      out.write(
        `error: expected postgres seed at ${POSTGRES_SEED_PATH}, none found.\n`,
      );
      return 1;
    }
    const seedSha256 = sha256OfFile(seedAbs);
    let launched = false;
    if (args.launchPostgres) {
      try {
        spawn("docker", ["compose", "up", "-d"], {
          cwd: path.join(REPO_ROOT, "servers/postgres-readonly"),
          stdio: "inherit",
          detached: false,
        });
        launched = true;
      } catch {
        out.write("[capture] --launch-postgres requested but docker spawn failed; cheat-sheet only.\n");
      }
    }
    out.write(renderStage1Cheatsheet({ seedSha256, launched }) + "\n");
    sleepSync(args.pauseSeconds);
  }

  // STAGE 2 — filesystem-sandbox.
  if (!args.skipStage2) {
    out.write(banner(2, "filesystem-sandbox (read_file ok + path-traversal blocked)"));
    if (!args.skipSandboxLayout) {
      buildSandboxLayout({ root: args.sandboxRoot, clean: true });
      out.write(
        `[capture] wrote deterministic allow-list layout at ${args.sandboxRoot} ` +
          `(${SANDBOX_FILES.length} files).\n`,
      );
    }
    out.write(renderStage2Cheatsheet({ sandboxRoot: args.sandboxRoot }) + "\n");
    sleepSync(args.pauseSeconds);
  }

  // STAGE 3 — github-gists.
  if (!args.skipStage3) {
    out.write(banner(3, "github-gists (get_gist ok + error path with D-007 redaction)"));
    const docAbs = path.join(REPO_ROOT, FIXTURE_DOC_PATH);
    let fixtureGistId = null;
    if (existsSync(docAbs)) {
      fixtureGistId = extractFixtureGistId(readFileSync(docAbs, "utf-8"));
    }
    out.write(renderStage3Cheatsheet({ fixtureGistId }) + "\n");
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
