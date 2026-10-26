/**
 * A 2xx JSON body that is not a gist names the request instead of passing as
 * one (#296).
 *
 * The client cast the parsed body `as Gist` and `projectGist` read it unchecked.
 * Measured on main, `getGist` through a stub fetch answering 200:
 *
 *     null                                 TypeError: Cannot read properties of null (reading 'files')
 *     []                                   OK {"description":null,"public":false,"files":[],...}
 *     {}                                   OK {"description":null,"public":false,"files":[],...}
 *     {"id":"abc","files":{"a.md":null}}   TypeError: Cannot read properties of null (reading 'content')
 *
 * The OK rows carry no `id` and no `html_url`: the empty "gist" #241 named.
 *
 * The check #296 added required `id` and `files` only (#332). Measured on main
 * f28344b, `getGist(defaultToolDeps(client), "abc")`:
 *
 *     {"id":"abc","files":{}}                                       OK {..., no html_url key}
 *     {"id":"abc","html_url":42,"files":{"a.md":{"content":"x"}}}   OK {..., "html_url":42, ...}
 *     {..., "description":5}                                        OK {..., "description":5, ...}
 *     {..., "files":{"a.md":{..., "language":7}}}                   OK {..., "language":7, ...}
 *
 * #332 left `public`, projected as `Boolean(g.public)` (#335). Measured on main
 * cb6e1f3, the same call with an otherwise valid body:
 *
 *     "public":"false"   OK {..., "public":true, ...}
 *     "public":1         OK {..., "public":true, ...}
 *     no public          OK {..., "public":false, ...}
 *
 * #335 left the other coerced fields (#340). Measured on main beb8a59:
 *
 *     gist "truncated":"false"   OK {..., "truncated":true}
 *     gist "truncated":1         OK {..., "truncated":true}
 *     file "truncated":"false"   OK {..., file "truncated":true}
 *     file "size":"999"          OK {..., file "size":2}   (silently recomputed)
 *     file "content":42          OK {..., file "content":null, "truncated":false}
 */
import { describe, expect, it } from "vitest";

import { type FetchLike, GistsClient, GithubApiError } from "../src/client.js";
import type { GistsConfig } from "../src/config.js";
import { defaultToolDeps, getGist } from "../src/tools.js";

const GIST = {
  id: "abc",
  description: "d",
  public: true,
  html_url: "https://gist.github.com/abc",
  files: { "a.md": { filename: "a.md", size: 2, content: "hi", language: "Markdown" } },
};

/** `GIST` with its one file's fields overridden (#340). */
function withFile(fields: Record<string, unknown>): object {
  return { ...GIST, files: { "a.md": { ...GIST.files["a.md"], ...fields } } };
}

function client(body: string): GistsClient {
  const cfg: GistsConfig = {
    token: "ghp_test",
    baseUrl: "https://api.github.test",
    userAgent: "ua/0.1",
    timeoutMs: 2_000,
  };
  const fetch: FetchLike = async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  return new GistsClient({ cfg, fetch });
}

const NOT_A_GIST: ReadonlyArray<[string, string, string]> = [
  ["null", "null", "expected an object, got null"],
  ["an array", "[]", "expected an object, got an array"],
  ["a number", "5", "expected an object, got number"],
  ["an empty object", "{}", "no string id"],
  ["a numeric id", JSON.stringify({ ...GIST, id: 5 }), "no string id"],
  ["an empty id", JSON.stringify({ ...GIST, id: "" }), "no string id"],
  ["no files", JSON.stringify({ id: "abc" }), "no files object"],
  ["files as an array", JSON.stringify({ ...GIST, files: [] }), "no files object"],
  ["a null file", JSON.stringify({ ...GIST, files: { "a.md": null } }), 'file "a.md" is not an object'],
  ["a string file", JSON.stringify({ ...GIST, files: { "a.md": "hi" } }), 'file "a.md" is not an object'],
  // #332: the fields the projection hands back typed, which #296 did not check.
  ["no html_url", JSON.stringify({ id: "abc", files: {} }), "no string html_url"],
  [
    "a numeric html_url",
    JSON.stringify({ id: "abc", html_url: 42, files: { "a.md": { content: "x" } } }),
    "no string html_url",
  ],
  ["an empty html_url", JSON.stringify({ ...GIST, html_url: "" }), "no string html_url"],
  ["a numeric description", JSON.stringify({ ...GIST, description: 5 }), "description is not a string or null"],
  [
    "a numeric language",
    JSON.stringify({ ...GIST, files: { "a.md": { ...GIST.files["a.md"], language: 7 } } }),
    'file "a.md" has a language that is not a string or null',
  ],
  // #335: the flag the projection coerced with `Boolean()`.
  ["a string public", JSON.stringify({ ...GIST, public: "false" }), "public is not a boolean"],
  ["a numeric public", JSON.stringify({ ...GIST, public: 1 }), "public is not a boolean"],
  ["no public", JSON.stringify({ ...GIST, public: undefined }), "public is not a boolean"],
  // #340: the optional fields the projection coerced or recomputed.
  ["a string gist truncated", JSON.stringify({ ...GIST, truncated: "false" }), "truncated is not a boolean"],
  ["a numeric gist truncated", JSON.stringify({ ...GIST, truncated: 1 }), "truncated is not a boolean"],
  ["a null gist truncated", JSON.stringify({ ...GIST, truncated: null }), "truncated is not a boolean"],
  [
    "a string file truncated",
    JSON.stringify(withFile({ truncated: "false" })),
    'file "a.md" has a truncated that is not a boolean',
  ],
  [
    "a string size",
    JSON.stringify(withFile({ size: "999" })),
    'file "a.md" has a size that is not a non-negative integer',
  ],
  ["a null size", JSON.stringify(withFile({ size: null })), 'file "a.md" has a size that is not a non-negative integer'],
  ["a negative size", JSON.stringify(withFile({ size: -1 })), 'file "a.md" has a size that is not a non-negative integer'],
  ["a fractional size", JSON.stringify(withFile({ size: 1.5 })), 'file "a.md" has a size that is not a non-negative integer'],
  ["a numeric content", JSON.stringify(withFile({ content: 42 })), 'file "a.md" has content that is not a string or null'],
  [
    "an object content",
    JSON.stringify(withFile({ content: { text: "hi" } })),
    'file "a.md" has content that is not a string or null',
  ],
];

describe("a 2xx body that is not a gist (#296)", () => {
  it.each(NOT_A_GIST)("get_gist refuses %s, naming the request", async (_label, body, why) => {
    const err = await client(body).getGist("abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as Error).message).toBe(
      `github_api_error (200 GET /gists/abc): response was not a gist: ${why}`,
    );
  });

  it.each(NOT_A_GIST)("update_gist_file refuses %s in the PATCH response", async (_label, body, why) => {
    const err = await client(body)
      .updateGistFile({ gistId: "abc", filename: "a.md", content: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as Error).message).toBe(
      `github_api_error (200 PATCH /gists/abc): response was not a gist: ${why}`,
    );
  });

  it("the get_gist tool surfaces it instead of an empty gist", async () => {
    const err = await getGist(defaultToolDeps(client("[]")), "abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
  });

  it("a real gist body still projects (control)", async () => {
    const out = await getGist(defaultToolDeps(client(JSON.stringify(GIST))), "abc");
    expect(out.id).toBe("abc");
    expect(out.html_url).toBe(GIST.html_url);
    expect(out.files.map((f) => f.filename)).toEqual(["a.md"]);
  });

  it("a null description and a null language still project (control, #332)", async () => {
    const body = { ...GIST, description: null, files: { "a.md": { ...GIST.files["a.md"], language: null } } };
    const out = await getGist(defaultToolDeps(client(JSON.stringify(body))), "abc");
    expect(out.description).toBeNull();
    expect(out.files[0]?.language).toBeNull();
  });

  it("an absent description and language project as null (control, #332)", async () => {
    const body = { id: "abc", html_url: GIST.html_url, public: true, files: { "a.md": { content: "x" } } };
    const out = await getGist(defaultToolDeps(client(JSON.stringify(body))), "abc");
    expect(out.description).toBeNull();
    expect(out.files[0]?.language).toBeNull();
    expect(out.html_url).toBe(GIST.html_url);
  });

  it.each([true, false])("a boolean public %s projects unchanged (control, #335)", async (pub) => {
    const out = await getGist(defaultToolDeps(client(JSON.stringify({ ...GIST, public: pub }))), "abc");
    expect(out.public).toBe(pub);
  });

  it("an empty files object is a gist with no files, not a refusal (control)", async () => {
    const out = await getGist(defaultToolDeps(client(JSON.stringify({ ...GIST, files: {} }))), "abc");
    expect(out.files).toEqual([]);
  });

  it.each([true, false])("a boolean gist and file truncated %s project unchanged (control, #340)", async (flag) => {
    const body = { ...withFile({ truncated: flag }), truncated: flag };
    const out = await getGist(defaultToolDeps(client(JSON.stringify(body))), "abc");
    expect(out.truncated).toBe(flag);
    expect(out.files[0]?.truncated).toBe(flag);
  });

  it("absent truncated, size and content project as before (control, #340)", async () => {
    const body = { ...GIST, files: { "a.md": { filename: "a.md" } } };
    const out = await getGist(defaultToolDeps(client(JSON.stringify(body))), "abc");
    expect(out.truncated).toBe(false);
    expect(out.files[0]).toEqual({ filename: "a.md", size: null, language: null, truncated: false, content: null });
  });

  it("an absent size is still computed from the content (control, #340)", async () => {
    const out = await getGist(defaultToolDeps(client(JSON.stringify(withFile({ size: undefined, content: "héllo" })))), "abc");
    expect(out.files[0]?.size).toBe(6);
    expect(out.files[0]?.content).toBe("héllo");
  });

  it("a size of 0, a null content and an empty content still project (control, #340)", async () => {
    const out = await getGist(defaultToolDeps(client(JSON.stringify(withFile({ size: 0, content: null })))), "abc");
    expect(out.files[0]).toMatchObject({ size: 0, content: null, truncated: false });
    const empty = await getGist(defaultToolDeps(client(JSON.stringify(withFile({ size: 0, content: "" })))), "abc");
    expect(empty.files[0]).toMatchObject({ size: 0, content: "", truncated: false });
  });
});
