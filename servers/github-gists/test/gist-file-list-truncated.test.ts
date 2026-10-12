/**
 * `get_gist` carries GitHub's gist-level `truncated` flag (#267).
 *
 * The API lists at most 300 files and sets a top-level `truncated: true` when a
 * gist has more. The projection kept the per-file flag and dropped this one, so
 * a 300+ file gist came back looking complete.
 */
import { describe, expect, it } from "vitest";

import type { Gist } from "../src/client.js";
import { projectGist } from "../src/tools.js";

function gist(nFiles: number, truncated?: unknown): Gist {
  const files: Gist["files"] = {};
  for (let i = 0; i < nFiles; i++) {
    const name = `f${String(i).padStart(3, "0")}.md`;
    files[name] = { filename: name, size: 1, content: "x" };
  }
  return {
    id: "g",
    description: null,
    public: true,
    html_url: "https://gist.github.com/u/g",
    files,
    ...(truncated === undefined ? {} : { truncated: truncated as boolean }),
  };
}

describe("the gist-level truncated flag (#267)", () => {
  it("a 300-file list GitHub marks truncated says so", () => {
    const out = projectGist(gist(300, true), 1_000_000);
    expect(out.files).toHaveLength(300);
    expect(out.files.some((f) => f.truncated)).toBe(false);
    expect(out.truncated).toBe(true);
  });

  it("is false when GitHub sends false or omits it", () => {
    expect(projectGist(gist(3, false), 1_000_000).truncated).toBe(false);
    expect(projectGist(gist(3), 1_000_000).truncated).toBe(false);
  });

  it("is always a boolean in the output", () => {
    expect(typeof projectGist(gist(1, "yes"), 1_000_000).truncated).toBe("boolean");
  });
});
