# filesystem-sandbox

> MCP server exposing `list_directory`, `read_file`, and `write_file` constrained to an operator-defined allow-list. Symlink-safe; path-traversal-rejecting; mandatory allow-list at boot.

## Threat model

**The sandbox protects against:** a misbehaving (or attacker-influenced)
MCP client asking the server to read or write outside the configured
allow-list. Every input path is canonicalized via `fs.realpath` and
checked against the resolved allow-list roots *before* any filesystem
syscall touches it. The following all surface as `sandbox refusal`
errors before any IO:

- `..` traversal that lands outside the allow-list.
- Absolute paths outside the allow-list.
- Symlinks under the allow-list pointing outside it.
- Symlinks at parent components of a non-existent target path.
- Null-byte injection (path truncation tricks).
- ASCII control characters (`0x01–0x1f`, `0x7f`) including newline / CR.
- Relative paths (rejected categorically — CWD-dependent behavior is a
  footgun in a multi-client server).
- Empty input.

**The sandbox does NOT protect against:**

- **Resource exhaustion.** A client legitimately reading or writing
  many large files inside the allow-list can still saturate the
  process's I/O or disk. Per-call byte cap (`MCP_FS_SANDBOX_MAX_BYTES`)
  helps, but coordinated abuse is downstream's concern.
- **Denial-of-service via repeated small calls.** No rate limiting
  here; the host or a proxy needs to apply that.
- **Reading sensitive files the operator legitimately placed under
  the allow-list.** The sandbox enforces the allow-list, not the
  contents of it. Operators are responsible for ensuring the
  allow-list is the right shape.
- **Audit/logging.** The server doesn't log accesses. A wrapping
  layer can.

**Trust assumptions:**

- The MCP client is partially-trusted: it can ask for files, but
  cannot escape the allow-list no matter what it asks for.
- The operator configures the allow-list at boot and is responsible
  for the security posture of those directories.
- The filesystem is fully trusted: the server believes `fs.realpath`.

## Configuration

| Env var | Required? | Default | What it does |
| ------- | --------- | ------- | ------------ |
| `MCP_FS_SANDBOX_ALLOWLIST` | **yes** | — | Colon-separated absolute paths (Unix); semicolon on Windows. Each path is resolved to its canonical real-path at boot. Refusing to start with an empty allow-list is intentional — D-005, no permissive default. |
| `MCP_FS_SANDBOX_READ_ONLY` | no | `0` | When `1`/`true`/`yes`, `write_file` is refused with `WriteForbiddenError`. |
| `MCP_FS_SANDBOX_MAX_BYTES` | no | `1000000` | Per-call byte cap for read / write. Files larger than this surface as `FileTooLargeError` instead of being truncated. |

## Tools

### `list_directory(path)`

Lists entries (name, kind, size) under an allow-listed directory. Path
must be absolute. Returns a JSON array sorted by name.

### `read_file(path)`

Returns the UTF-8 text content of a file. Files larger than
`MCP_FS_SANDBOX_MAX_BYTES` are rejected. Non-UTF-8 content is rejected
explicitly (no garbled bytes in tool results).

### `write_file(path, content)`

Writes UTF-8 text. Parent directory must exist and be inside the
allow-list; symlinks at any path component pointing outside the
allow-list are rejected. Disabled entirely when
`MCP_FS_SANDBOX_READ_ONLY=1`.

## Install

```bash
cd servers/filesystem-sandbox
npm install
npm run build
```

## Run (Claude Desktop)

```json
{
  "mcpServers": {
    "filesystem-sandbox": {
      "command": "node",
      "args": ["/absolute/path/to/dist/server.js"],
      "env": {
        "MCP_FS_SANDBOX_ALLOWLIST": "/home/user/projects/scratch:/tmp/agent-uploads",
        "MCP_FS_SANDBOX_MAX_BYTES": "2000000"
      }
    }
  }
}
```

## Test

```bash
npm test                # 38 hermetic vitest tests
npm run lint            # eslint
npm run typecheck       # tsc --noEmit
```

The test suite creates throwaway tmpdirs and exercises every path the
sandbox should reject (traversal, symlinks pointing outside, null
bytes, control chars, sibling roots, non-existent parents) plus the
positive paths (file inside allow-list, sub-traversal that stays
inside, root itself as a directory).
