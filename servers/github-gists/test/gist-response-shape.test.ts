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

  it("an empty files object is a gist with no files, not a refusal (control)", async () => {
    const out = await getGist(defaultToolDeps(client(JSON.stringify({ ...GIST, files: {} }))), "abc");
    expect(out.files).toEqual([]);
  });
});
