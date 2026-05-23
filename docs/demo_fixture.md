# 60-second demo: fixture inputs

The cookbook's 60-second walkthrough (tracked in #16) exercises one
tool per shipped server. The recording can be reproduced — operator
side — only if the *inputs* to each tool call stay identical across
re-captures. This doc names those inputs.

`tools/capture-demo.mjs` reads this file to surface the fixture
values in its STAGE banners; if the file is missing or the field is
missing, the script falls back to a placeholder so the operator
sees what to fill in.

## STAGE 1 — `postgres-readonly`

Seed file: `servers/postgres-readonly/sample-db/init.sql` (committed,
load via `docker compose up -d` in that server's directory). The
sha256 of the seed file is printed by `tools/capture-demo.mjs` so a
re-capture can confirm the schema hasn't drifted.

The exact tool invocations are documented inline in the STAGE 1
cheat-sheet — see the script.

## STAGE 2 — `filesystem-sandbox`

Allow-list dir: `/tmp/mcp-demo-fs-sandbox/` (created on every script
run with a known small layout: `hello.txt`, `nested/note.md`). The
operator copy-pastes the printed `MCP_FS_SANDBOX_ALLOWLIST` env var
into the server's startup command; recording shows a successful
`read_file` on the allowed path and a blocked `read_file` against
`/etc/passwd`.

## STAGE 3 — `github-gists`

Fixture gist (public; pin so re-captures look identical):

`gist_id`: `aa5a3adaae1c2f8b7e9b1c0d4f6e8a9c`

This is a placeholder — the actual public fixture gist is whichever
one the operator picks on first capture. To make the recording
identical across re-captures, replace the value above with the gist
ID of any small, stable public gist (a one-file README is enough)
and commit. The script will then print the same fixture ID every
run.

For the error-path / token-redaction half of the stage, the script
intentionally uses a non-existent gist id (`this-id-does-not-exist-anywhere`)
to drive a 404 — the recording shows the resolved URL in the error
message has no trailing token query (D-007 redaction guarantee).
