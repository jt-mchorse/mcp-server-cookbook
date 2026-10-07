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
load via `docker compose up -d --wait` in that server's directory).

`seed_sha256`: `bca28b674b42d81325f1350d696199a84bb7a211387eafba07386c519da59492`

`tools/capture-demo.mjs` compares the seed file's sha256 with that pin and
stops on a mismatch, so a re-capture cannot run against a seed that changed
without anyone deciding it should (#225). Change the seed and the pin in the
same commit; `tools/capture-demo.test.mjs` fails until they agree.

The check is on the *file*. The postgres image runs
`docker-entrypoint-initdb.d` scripts only when its data directory is empty,
so a container created from an older seed keeps that seed's data across
`docker compose up -d --wait`. After a seed change, recreate it:
`docker compose down -v && docker compose up -d --wait`.

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

`gist_id`: `<unset>`

Not pinned yet. The fixture gist is whichever small, stable public gist
the operator picks on first capture (a one-file README is enough):
replace `<unset>` above with its ID and commit, and the script will
print the same fixture ID every run. Until then the script says it is
using a placeholder rather than presenting one as a real input. This
line used to hold a made-up ID, which the script printed as the
"Deterministic input" and which returned 404 from `get_gist` (#219).

For the error-path / token-redaction half of the stage, the script
intentionally uses a non-existent gist id (`this-id-does-not-exist-anywhere`)
to drive a 404 — the recording shows the resolved URL in the error
message has no trailing token query (D-007 redaction guarantee).
