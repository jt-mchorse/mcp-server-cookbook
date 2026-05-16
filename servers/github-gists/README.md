# github-gists

> MCP server wrapping a small slice of the GitHub Gists REST API behind two tools (`get_gist`, `update_gist_file`). Demonstrates the cookbook's **SaaS-API-wrapper with token auth** pattern — the token is read from an env var, attached on each request, and **never** echoed back in tool responses, error messages, or logs.

## Threat model

**The server protects against:**

- **Token leakage to MCP clients.** The `Authorization` header is built
  inside the client and never copied into a tool response or an error
  message. Error messages carry the HTTP status, the request *path*
  (without query strings that could carry secrets), and the
  GitHub-reported `message` field — they do not carry the bearer
  value, the request body, or any unredacted response chunk.
- **Token leakage to logs.** The boot banner reports `token=present` or
  `token=absent`, not the value. The request body is intentionally
  dropped from any error-message context because client-supplied
  content (gist content, descriptions) may itself be secret.
- **Confused-deputy writes.** `update_gist_file` refuses to run when no
  token is configured, surfacing a `TokenRequiredError` rather than
  falling through to an unauthenticated PATCH that would 401.
- **Configuration drift.** A missing `http://` / `https://` scheme on
  the API base URL refuses to start the server. Non-integer or
  non-positive timeouts refuse to start the server. The whole "fail
  loud at boot" posture is the same as the filesystem-sandbox's
  refusal of an empty allow-list (D-005).
- **Tool-result size blowup.** Per-file content cap (100 KB) means a
  huge committed file in a gist won't dump megabytes into an MCP
  response; the file is returned with `truncated: true` and `content:
  null`. The error-message path also caps text-body fallback at 200
  characters.
- **Hung tool calls.** Per-call timeout (default 10 s) surfaces as a
  clear `RequestTimeoutError` rather than wedging the MCP client.

**The server does NOT protect against:**

- **The token being valid for too many things.** Token scoping is the
  operator's responsibility. Use a fine-grained PAT with `gist`
  scope only.
- **Rate-limit DoS by a misbehaving client.** GitHub's per-token rate
  limit applies; this server does not add a second one. Coordinated
  abuse is the host's concern.
- **Reading accidentally-public gists.** The server enforces the
  GitHub API's access rules but does not police what the operator
  shares.
- **Audit logging.** The server doesn't log per-call activity beyond
  the boot banner; a wrapping layer should.
- **Server-side request forgery via `MCP_GITHUB_GISTS_BASE_URL`.** The
  operator sets the base URL; if they set it to an attacker-controlled
  origin, the server will dutifully send the token there. This is
  why "fail loud at boot" is the right posture but it's not a
  substitute for not configuring a hostile base URL.

**Trust assumptions:**

- The MCP client is partially-trusted: it can ask for any gist by id
  and can ask to update files inside any gist the token has write
  access to. Both are bounded by GitHub's access rules.
- The operator configures `GITHUB_TOKEN` and is responsible for its
  scope.
- GitHub itself is fully trusted: the server believes the API's
  response shape.

## Configuration

| Env var | Required? | Default | What it does |
| ------- | --------- | ------- | ------------ |
| `GITHUB_TOKEN` | for `update_gist_file` | — | Personal access token (classic or fine-grained with `gist` scope). Optional for reading public gists but always sent when set so rate limits are higher and private gists are reachable. **Never echoed.** |
| `MCP_GITHUB_GISTS_BASE_URL` | no | `https://api.github.com` | Override for GitHub Enterprise Server (`https://github.example.com/api/v3`) or for fixture servers in tests. Must start with `http://` or `https://`. Trailing slash is stripped. |
| `MCP_GITHUB_GISTS_USER_AGENT` | no | `mcp-cookbook-github-gists/0.1.0` | UA string sent on every request. GitHub rejects requests with no UA header. |
| `MCP_GITHUB_GISTS_TIMEOUT_MS` | no | `10000` | Per-call request timeout in milliseconds. Must be a positive integer. Tools surface a clear `request_timed_out` error rather than hanging. |

## Tools

### `get_gist(gist_id)`

Read a gist by id. Returns the projected gist shape:

```json
{
  "id": "abc123",
  "description": "demo",
  "public": true,
  "html_url": "https://gist.github.com/user/abc123",
  "files": [
    { "filename": "a.md", "size": 42, "language": "Markdown",
      "truncated": false, "content": "..." }
  ]
}
```

Files larger than the per-file cap (100 KB) come back with
`truncated: true` and `content: null` so a large committed file does
not blow the MCP response budget.

Auth is optional for public gists but used when `GITHUB_TOKEN` is set
for higher rate limits and access to private gists owned by the
token's user.

### `update_gist_file(gist_id, filename, content, description?)`

Overwrite one file inside an existing gist. The optional `description`
also updates the gist's description if given. Returns the post-update
gist projection (same shape as `get_gist`).

**Requires `GITHUB_TOKEN`.** Without one, surfaces a `TokenRequiredError`
before sending any request.

## Install

```bash
cd servers/github-gists
npm install
npm run build
```

## Run (stdio MCP transport)

```bash
export GITHUB_TOKEN="ghp_yourTokenWithGistScope"
node dist/server.js
# stderr: github-gists MCP server starting; base=https://api.github.com token=present
```

To attach it to Claude Desktop, add to its `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "github-gists": {
      "command": "node",
      "args": ["/absolute/path/to/servers/github-gists/dist/server.js"],
      "env": { "GITHUB_TOKEN": "ghp_yourTokenWithGistScope" }
    }
  }
}
```

## Sample client invocation

The server speaks stdio MCP, so you can drive it with any MCP client.
For a quick local smoke test using the SDK's reference client:

```bash
# 1. read a public gist (no token needed)
echo '{"method":"tools/call","params":{"name":"get_gist","arguments":{"gist_id":"<any-public-gist-id>"}}}' \
  | node dist/server.js

# 2. update a file inside a gist you own (token required)
export GITHUB_TOKEN="ghp_..."
echo '{"method":"tools/call","params":{"name":"update_gist_file","arguments":{"gist_id":"<your-gist-id>","filename":"notes.md","content":"hello from MCP"}}}' \
  | node dist/server.js
```

For an interactive REPL across all your servers, use the
[official MCP inspector](https://github.com/modelcontextprotocol/inspector).

## Tests

```bash
npm test          # vitest, 28 hermetic unit tests, no network
npm run typecheck # tsc --noEmit
npm run lint      # eslint
```

Tests inject a fake `fetch` so the request shape, redaction posture,
and error surfaces are verified without any live GitHub call.
Real-API smoke testing against a live token is operator-triggered
locally; CI is intentionally kept token-free.

## Pattern notes for the cookbook reader

When adapting this server to your own SaaS:

1. Keep the **token-redaction posture** at the client layer, not the
   tool layer. Errors that escape the client should already be safe to
   surface; the tool layer should not have to know what's secret.
2. **Drop request bodies from error context** by default. Bodies often
   contain user content that you wouldn't want appearing in PR
   comments, traces, or logs.
3. **Refuse to start on bad config.** Cookbook servers fail loud at
   boot rather than silently degrading.
4. **Validate args at the public-API boundary** (`GistsClient` methods)
   so a malformed call is rejected before any network IO.
5. **Cap per-call payloads** (per-file size in this server,
   per-call byte cap in the filesystem-sandbox) — large responses are
   an availability issue for the MCP client.
