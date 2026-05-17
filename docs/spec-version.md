# MCP spec & SDK version pin

This document is the single source of truth for the
`@modelcontextprotocol/sdk` version every server in this cookbook
pins to. The `spec-version` CI job (in `.github/workflows/ci.yml`)
runs `tools/check-spec-version.mjs` against this file and fails the
build if any server's `package.json` drifts from the pinned range.

## Pinned versions

<!--
The block below is machine-parsed by tools/check-spec-version.mjs.
Keep the exact field names and the fenced YAML block. The script
matches against the first such block in this file.
-->

```yaml
sdk_package: "@modelcontextprotocol/sdk"
sdk_version: "^1.5.0"
mcp_spec_revision: "2025-06-18"
mcp_spec_url: "https://modelcontextprotocol.io/specification/2025-06-18"
notes: "SDK 1.5.x implements the 2025-06-18 spec revision. When you bump the SDK pin, update both fields together."
```

## What the CI check enforces

`tools/check-spec-version.mjs` runs at every PR and asserts two
invariants:

1. **Recorded-vs-actual.** Every `servers/*/package.json` must declare
   `@modelcontextprotocol/sdk` at the exact `sdk_version` string
   declared above. If you bump one server but forget the doc — or
   bump the doc but forget a server — the job fails with a message
   naming the file.
2. **Intra-repo consistency.** Every server pins the *same* SDK
   version. The cookbook is "per-server independence" by design
   (D-002), but the SDK is one library; a server lagging by a minor
   would silently drift its spec coverage.

The script reads the YAML block above by parsing the first fenced
```yaml block in this file. The format is strict — no other fences
above it, no missing fields. The script's own tests cover the parse
edge cases (`tools/check-spec-version.test.mjs`).

## Upstream spec verification

The check above is intentionally **offline**: CI does not hit
`modelcontextprotocol.io`. Network checks would make the build
flake on DNS or upstream throttling, and the spec revision changes
slowly enough that a manual operator step is the right hop for
verification. The flow is:

1. Watch the
   [SDK release notes](https://github.com/modelcontextprotocol/typescript-sdk/releases)
   for a new minor or major.
2. Read its release notes to find the spec revision string it
   targets.
3. Open `docs/spec-version.md`, update `sdk_version`,
   `mcp_spec_revision`, and `mcp_spec_url` together.
4. Bump every `servers/*/package.json` to the new range.
5. Refresh each server's `package-lock.json` (`npm install` in each
   server directory).
6. Run `node tools/check-spec-version.mjs` locally to confirm the
   doc and the packages agree.
7. Open a PR. CI runs the same script. If the bump introduces a
   real spec break, server tests should catch it; if a server lints
   or builds against a removed surface, that's the signal to read
   the SDK changelog and update call sites.

## Why a pin at all

Two reasons. **First**, MCP is a young spec; minor releases of the
SDK can ship surface changes the servers depend on (tool
annotations, content-block types, schema declarations). A pin
locks every server to a known-good spec revision and forces the
upgrade decision into a deliberate PR.

**Second**, the cookbook is meant to be a reference — the
threat-model writeups, the example client invocations, the docs in
each server's README all describe behavior at a *specific* spec
revision. Letting servers drift independently means the docs
mismatch the code, which is the failure mode this pin prevents.
