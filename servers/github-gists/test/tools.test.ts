import { describe, expect, it } from "vitest";

import type { Gist } from "../src/client.js";
import { projectGist, getGist, updateGistFile, defaultToolDeps } from "../src/tools.js";
import { GistsClient } from "../src/client.js";

const rawGist: Gist = {
  id: "abc",
  description: "demo",
  public: true,
  html_url: "https://gist.github.com/u/abc",
  files: {
    "b.md": { filename: "b.md", language: "Markdown", size: 5, content: "hello" },
    "a.md": { filename: "a.md", language: null, size: 3, content: "hi" },
  },
};

describe("projectGist", () => {
  it("sorts files by name and projects to the response shape", () => {
    const out = projectGist(rawGist, 1_000_000);
    expect(out.id).toBe("abc");
    expect(out.files.map((f) => f.filename)).toEqual(["a.md", "b.md"]);
    expect(out.files[0]).toMatchObject({
      filename: "a.md",
      content: "hi",
      size: 3,
      truncated: false,
      language: null,
    });
  });

  it("truncates files larger than the cap", () => {
    const big: Gist = {
      ...rawGist,
      files: { "big.txt": { filename: "big.txt", content: "a".repeat(2000) } },
    };
    const out = projectGist(big, 1000);
    expect(out.files[0].truncated).toBe(true);
    expect(out.files[0].content).toBeNull();
    expect(out.files[0].size).toBe(2000);
  });

  it("preserves the API's own truncated flag", () => {
    const g: Gist = {
      ...rawGist,
      files: { "x.md": { filename: "x.md", truncated: true, size: 999, content: "partial" } },
    };
    const out = projectGist(g, 1_000_000);
    expect(out.files[0].truncated).toBe(true);
  });

  it("defaults description and public when missing", () => {
    const g: Gist = { ...rawGist, description: null, public: false, files: {} };
    const out = projectGist(g, 1_000_000);
    expect(out.description).toBeNull();
    expect(out.public).toBe(false);
    expect(out.files).toEqual([]);
  });
});

// ---------------- tool entry points ----------------

class StubClient {
  public getGistCalls: string[] = [];
  public updateCalls: Array<{ gistId: string; filename: string; content: string; description?: string }> = [];

  constructor(private response: Gist) {}

  async getGist(id: string): Promise<Gist> {
    this.getGistCalls.push(id);
    return this.response;
  }

  async updateGistFile(args: { gistId: string; filename: string; content: string; description?: string }): Promise<Gist> {
    this.updateCalls.push(args);
    return this.response;
  }
}

describe("getGist (tool)", () => {
  it("delegates to the client and projects the response", async () => {
    const stub = new StubClient(rawGist);
    const deps = defaultToolDeps(stub as unknown as GistsClient);
    const out = await getGist(deps, "abc");
    expect(stub.getGistCalls).toEqual(["abc"]);
    expect(out.id).toBe("abc");
    expect(out.files.map((f) => f.filename)).toEqual(["a.md", "b.md"]);
  });
});

describe("updateGistFile (tool)", () => {
  it("forwards snake_case args to the client and projects the response", async () => {
    const stub = new StubClient({ ...rawGist, description: "updated" });
    const deps = defaultToolDeps(stub as unknown as GistsClient);
    const out = await updateGistFile(deps, {
      gist_id: "abc",
      filename: "a.md",
      content: "new",
      description: "updated",
    });
    expect(stub.updateCalls).toEqual([
      { gistId: "abc", filename: "a.md", content: "new", description: "updated" },
    ]);
    expect(out.description).toBe("updated");
  });

  it("forwards undefined description as undefined (not the string 'undefined')", async () => {
    const stub = new StubClient(rawGist);
    const deps = defaultToolDeps(stub as unknown as GistsClient);
    await updateGistFile(deps, { gist_id: "abc", filename: "a.md", content: "new" });
    expect(stub.updateCalls[0].description).toBeUndefined();
  });
});
