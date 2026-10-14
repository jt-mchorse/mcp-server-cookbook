/**
 * A base URL `fetch` would refuse is refused at boot, without echoing it (#269).
 *
 * `MCP_GITHUB_GISTS_BASE_URL` was gated on an `http(s)://` prefix only. A value
 * with userinfo (`https://user:pass@proxy/api/v3`) booted, then every call
 * failed inside `fetch` with undici's `Request cannot be constructed from a URL
 * that includes credentials: <the whole URL>`, and that text was the tool
 * result: the password, echoed to the client. A value `new URL()` cannot parse
 * failed every call with `Failed to parse URL from <url>`. Both are refused by
 * the config now, on the env path and the programmatic one, and neither
 * message quotes the value.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GistsClient } from "../src/client.js";
import { type GistsConfig, readGistsConfigFromEnv, validateGistsConfig } from "../src/config.js";

const SECRET = "PROXYSECRET42";

// (label, base URL) — each one fails every request inside `fetch`.
const UNFETCHABLE: Array<[string, string]> = [
  ["user and password", `https://ci-bot:${SECRET}@ghe-proxy.example.test/api/v3`],
  ["password only", `https://:${SECRET}@ghe-proxy.example.test`],
  ["user only (a token written as the user)", `http://${SECRET}@127.0.0.1:9`],
  ["a space in the host", `https://ghe ${SECRET}.example.test/api/v3`],
  ["an empty host", `https://`],
];

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
}

function cfgWith(baseUrl: string): GistsConfig {
  return { token: "ghp_test", baseUrl, userAgent: "ua/0.1", timeoutMs: 2_000 };
}

describe("MCP_GITHUB_GISTS_BASE_URL that fetch refuses is refused at boot (#269)", () => {
  it.each(UNFETCHABLE)("from the environment: %s", (_label, baseUrl) => {
    const message = messageOf(() => readGistsConfigFromEnv({ MCP_GITHUB_GISTS_BASE_URL: baseUrl }));
    expect(message).toMatch(/^MCP_GITHUB_GISTS_BASE_URL (must not contain|is not a URL)/);
    expect(message).not.toContain(SECRET);
  });

  it.each(UNFETCHABLE)("in a built config: %s", (_label, baseUrl) => {
    const message = messageOf(() => validateGistsConfig(cfgWith(baseUrl)));
    expect(message).toMatch(/^GistsConfig\.baseUrl (must not contain|is not a URL)/);
    expect(message).not.toContain(SECRET);
  });

  it.each(UNFETCHABLE)("by the GistsClient constructor: %s", (_label, baseUrl) => {
    // The path #269 measured: on main this constructed, and `get_gist` returned
    // undici's message with the URL in it.
    const message = messageOf(() => new GistsClient({ cfg: cfgWith(baseUrl) }));
    expect(message).toMatch(/GistsConfig\.baseUrl/);
    expect(message).not.toContain(SECRET);
  });

  it("names the host, so the operator can tell which value is wrong", () => {
    const message = messageOf(() =>
      readGistsConfigFromEnv({ MCP_GITHUB_GISTS_BASE_URL: UNFETCHABLE[0]![1] }),
    );
    expect(message).toContain('"ghe-proxy.example.test"');
  });

  it.each([
    ["the default", undefined, "https://api.github.com"],
    ["GHE with a port and path", "https://github.example.com:8443/api/v3/", "https://github.example.com:8443/api/v3"],
    ["loopback http", "http://127.0.0.1:9", "http://127.0.0.1:9"],
    ["an @ in the path, not the authority", "https://ghe.example.test/api/@v3", "https://ghe.example.test/api/@v3"],
  ])("still accepts %s", (_label, raw, expected) => {
    // The control: a gate that refused every URL would pass every row above.
    const env = raw === undefined ? {} : { MCP_GITHUB_GISTS_BASE_URL: raw };
    const cfg = readGistsConfigFromEnv(env);
    expect(cfg.baseUrl).toBe(expected);
    expect(() => validateGistsConfig(cfg)).not.toThrow();
  });
});

describe("the spawned server never prints the credential (#269)", () => {
  const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts");
  const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

  it(
    "refuses to start with one line that names the variable and not the password",
    async () => {
      const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, [TSX_CLI, SERVER], {
          env: { ...process.env, MCP_GITHUB_GISTS_BASE_URL: UNFETCHABLE[0]![1] },
          stdio: ["pipe", "ignore", "pipe"],
        });
        let err = "";
        const cap = setTimeout(() => child.kill(), 15_000);
        child.stderr.on("data", (d) => (err += String(d)));
        child.on("exit", (c) => {
          clearTimeout(cap);
          done({ code: c, stderr: err });
        });
      });
      expect(code).toBe(1);
      expect(stderr).toMatch(/^github-gists: refusing to start\. MCP_GITHUB_GISTS_BASE_URL must not contain/);
      expect(stderr).not.toContain(SECRET);
    },
    30_000,
  );
});
