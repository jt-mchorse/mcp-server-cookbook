# filesystem-sandbox-py (Python parity port)

A line-for-line port of [`../filesystem-sandbox/`](../filesystem-sandbox/)
to Python. Same threat model, same tools, same security primitive,
exposed via the official Python MCP SDK (`mcp >= 1.27`).

The cookbook ships a port of *one* server, not all four, because:

- One port is enough to prove the pattern translates idiomatically
  across the SDK boundary.
- The teaching point of `mcp-server-cookbook` is the security posture
  per server (D-003: every server's README leads with the threat
  model). Once the pattern translates for one, the others follow the
  same recipe.
- `filesystem-sandbox` is the simplest of the four (no DB driver, no
  SaaS API, no subprocess bridge), which keeps the comparison about
  the *primitive* (path validation + allow-list resolution) rather
  than about the SDK-specific driver wiring of each language.

## Tools

| Tool             | Input                                  | Output                                                       |
|------------------|----------------------------------------|--------------------------------------------------------------|
| `list_directory` | `{ path }`                             | JSON: `[{ name, kind, size? }]` sorted by name               |
| `read_file`      | `{ path }`                             | UTF-8 text; refuses binary content + files over `max_bytes` |
| `write_file`     | `{ path, content }`                    | JSON: `{ bytes_written }`. Refused under `read_only`.        |

## Threat model

Identical to the TypeScript server's README — refer to
[`../filesystem-sandbox/README.md`](../filesystem-sandbox/README.md)
for the full prose. Summary: every input path passes through
`Sandbox.resolve(...)` before any file syscall. Rejections surface as
typed `SandboxEscape` exceptions:

| Reason                          | Triggered by                                                       |
|---------------------------------|--------------------------------------------------------------------|
| `input_empty`                   | Empty string / non-string input                                    |
| `input_null_byte`               | `\0` in the input                                                  |
| `input_control_char`            | Other ASCII control chars (0x01-0x1f, 0x7f)                         |
| `input_relative_disallowed`     | Relative paths (rejected to avoid CWD-dependent surprises)         |
| `outside_allowlist`             | Resolved path doesn't sit under any allow-list root                |
| `symlink_outside_allowlist`     | (Same reason; surfaced via `outside_allowlist` after realpath)     |
| `root_does_not_exist`           | Allow-list root doesn't exist at server start                      |
| `not_a_file` / `not_a_directory`| Tool-level type assertions on the resolved path                    |

## Parity matrix

What's identical across the TS and Python implementations:

| Property                                                       | TS  | Py  |
|----------------------------------------------------------------|:---:|:---:|
| Threat model                                                   | ✅   | ✅   |
| Three tools (`list_directory`, `read_file`, `write_file`)      | ✅   | ✅   |
| Inputs validated for empty/null-byte/control-char/relative     | ✅   | ✅   |
| Allow-list roots resolved at construction via `realpath`       | ✅   | ✅   |
| Per-call `realpath` so symlinks-pointing-outside are rejected  | ✅   | ✅   |
| Trailing-sep prefix match (no `/tmp/foo` ↔ `/tmp/foobar`)       | ✅   | ✅   |
| `mustExist:false` for write-to-new-file (parent must exist)    | ✅   | ✅   |
| Binary file detection on `read_file`                           | ✅   | ✅   |
| Per-call byte cap (`MCP_FS_SANDBOX_MAX_BYTES`)                 | ✅   | ✅   |
| Read-only mode (`MCP_FS_SANDBOX_READ_ONLY`)                    | ✅   | ✅   |
| Required env (`MCP_FS_SANDBOX_ALLOWLIST`, fail on empty)       | ✅   | ✅   |

What's idiomatically different (same posture, different language):

| Aspect                          | TS                                     | Py                                            |
|---------------------------------|----------------------------------------|-----------------------------------------------|
| Sync vs async API on the prim.  | Async (`fs.realpath` is async in Node) | Sync (`os.path.realpath` is sync)             |
| Server boilerplate              | `@modelcontextprotocol/sdk` + stdio    | `mcp.server.Server` + `mcp.server.stdio`      |
| Test runner                     | `vitest`                               | `pytest`                                      |
| Lint / format                   | `eslint` / `prettier`                  | `ruff`                                        |
| Dependency posture              | `@modelcontextprotocol/sdk` required   | Primitive dep-free; SDK behind `[server]` extra|

The "dependency posture" row is the load-bearing difference: the
Python port's security primitive (`sandbox.py` + `tools.py` +
`config.py`) is *entirely* dep-free, so the tests run on a stdlib-only
Python install. The MCP SDK is only needed to *run* the server. The TS
implementation can't quite hit that because the SDK types thread
through the source. Both are honest postures; the Python one is
slightly stricter about the primitive/SDK separation.

## Run the server

```bash
cd servers/filesystem-sandbox-py
python -m venv .venv && . .venv/bin/activate
pip install -e '.[server,dev]'
MCP_FS_SANDBOX_ALLOWLIST=/tmp/scratch:/tmp/uploads mcp-filesystem-sandbox-py
```

Or as a Python module:

```bash
MCP_FS_SANDBOX_ALLOWLIST=/tmp/scratch python -m filesystem_sandbox.server
```

Wire into Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS):

```jsonc
{
  "mcpServers": {
    "filesystem-sandbox-py": {
      "command": "mcp-filesystem-sandbox-py",
      "env": { "MCP_FS_SANDBOX_ALLOWLIST": "/Users/you/scratch" }
    }
  }
}
```

## Tests

```bash
pip install -e '.[dev]'      # no [server] needed — primitive tests don't import mcp
pytest                        # 54 tests, ~60 ms
ruff check . && ruff format --check .
```

The test suite (`tests/test_sandbox.py` + `tests/test_tools.py` +
`tests/test_config.py`) pins **every security invariant** the TS suite
pins, plus a few Python-idiomatic ones (control-char parametrize over
boundary code points; sibling-prefix attack via two fresh tmp dirs).
Where the TS suite uses `vitest`'s `await expect(...).rejects` shape,
the Python tests use `pytest.raises(SandboxEscape) as ei; assert
ei.value.reason == ...` — same invariant, different syntax.

## Sample client run

A walkthrough comparing the TS and Python servers side-by-side lives
in the root README's `Quickstart`. Both expose identical tool schemas;
an MCP client interchange is byte-identical across the two
implementations modulo a tool-id rename (the Python server publishes
itself as `filesystem-sandbox-py`).

## Why these decisions

The decisions that drive the *primitive* are recorded once in the
cookbook's MEMORY:

- **D-005.** Allow-list resolved at construction, not per call.
- **D-006.** Path resolution uses `realpath` (follows symlinks), not
  `path.resolve` alone.

The Python port doesn't introduce new architectural decisions — it's a
parity translation. The implementation choice (official `mcp` SDK over
`fastmcp`) is documented in this server's PR description and the
follow-up issue thread.
