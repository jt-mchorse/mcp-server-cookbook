/**
 * A capped error text never ends in half a surrogate pair (#282).
 *
 * Both caps in `client.ts` were `slice(0, 200) + "…"`, and `slice` counts
 * UTF-16 code units. An upstream body of emoji, such as a proxy's or a GHE
 * front-end's error page, put a lone high surrogate before the ellipsis. The TS
 * SDK writes that as a bare `\ud83d` escape. The MCP Python client's strict
 * JSON parser then rejects the whole response line ("unexpected end of hex
 * escape"), and the call is never answered. Measured with `mcp` 1.30.0 against
 * a loopback 502: the aligned body was answered, and the body one character
 * longer hung until the client's own timeout.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { capErrorText, describeFetchFailure, GistsClient, GithubApiError } from "../src/client.js";
import type { GistsConfig } from "../src/config.js";

const EMOJI = String.fromCodePoint(0x1f600); // two code units: 0xD83D 0xDE00
const HIGH = String.fromCharCode(0xd83d);

/** True when `s` has a surrogate code unit without its partner. */
function hasLoneSurrogate(s: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

describe("capErrorText", () => {
  it.each([
    ["short text is returned whole, no ellipsis", "abc", 5, "abc"],
    ["text exactly at the cap is returned whole", "abcde", 5, "abcde"],
    ["a cut between two BMP characters keeps the cap", "abcdef", 3, "abc…"],
    ["a cut after a whole pair keeps the pair", `a${EMOJI}bc`, 3, `a${EMOJI}…`],
    ["a cut between the halves of a pair drops the high half", `ab${EMOJI}c`, 3, "ab…"],
  ])("%s", (_name, text, cap, expected) => {
    const out = capErrorText(text, cap);
    expect(out).toBe(expected);
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

async function upstream(status: number, body: string, type: string): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function getGistError(baseUrl: string): Promise<GithubApiError> {
  const cfg: GistsConfig = { token: null, baseUrl, userAgent: "ua/0.1", timeoutMs: 2_000 };
  const err = await new GistsClient({ cfg, fetch: globalThis.fetch as never })
    .getGist("abc")
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GithubApiError);
  return err as GithubApiError;
}

// "x" + 150 emoji: code unit 199 is the high half of an emoji.
const SPLIT = `x${EMOJI.repeat(150)}`;

describe("an upstream error reason is capped on a code point (#282)", () => {
  it("a raw 502 body cut at 200 does not end in a lone high surrogate", async () => {
    expect(SPLIT.slice(0, 200).endsWith(HIGH)).toBe(true); // precondition
    const err = await getGistError(await upstream(502, SPLIT, "text/plain; charset=utf-8"));
    expect(hasLoneSurrogate(err.message)).toBe(false);
    expect(err.message.endsWith(`${SPLIT.slice(0, 199)}…`)).toBe(true);
  });

  it("a JSON `message` cut at 200 does not end in a lone high surrogate", async () => {
    const body = JSON.stringify({ message: SPLIT });
    const err = await getGistError(await upstream(422, body, "application/json"));
    expect(hasLoneSurrogate(err.message)).toBe(false);
    expect(err.message.endsWith(`${SPLIT.slice(0, 199)}…`)).toBe(true);
  });

  it("a body whose cut falls between whole pairs keeps all 200 units", async () => {
    const aligned = EMOJI.repeat(150);
    const err = await getGistError(await upstream(502, aligned, "text/plain; charset=utf-8"));
    expect(hasLoneSurrogate(err.message)).toBe(false);
    expect(err.message.endsWith(`${aligned.slice(0, 200)}…`)).toBe(true);
  });
});

describe("a fetch-failure description is capped on a code point (#282)", () => {
  it("does not end in a lone high surrogate", () => {
    const text = describeFetchFailure(new Error(SPLIT));
    expect(SPLIT.length).toBeGreaterThan(200);
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text).toBe(`${SPLIT.slice(0, 199)}…`);
  });
});
