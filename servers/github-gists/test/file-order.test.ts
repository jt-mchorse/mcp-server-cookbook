/**
 * `projectGist` orders a gist's files by Unicode code point (#243).
 *
 * It used `localeCompare`, which collates by the HOST locale: `ä.md` came
 * before `B.md` under en_US and after `z.md` under sv_SE, so the same gist was
 * returned in a different order depending on where the server ran. That is the
 * defect #209 fixed in filesystem-sandbox's `list_directory`; these arms pin
 * the same order here. Every expected order below differs from what
 * `localeCompare` gives under any locale (`_` collates before letters there, and
 * after `B` by code point), so they hold on whatever host runs the suite.
 */
import { describe, expect, it } from "vitest";

import type { Gist } from "../src/client.js";
import { compareCodePoints, projectGist } from "../src/tools.js";

function order(names: string[]): string[] {
  const files: Gist["files"] = {};
  for (const n of names) files[n] = { filename: n, content: "x" };
  const g: Gist = { id: "g", description: null, public: true, html_url: "u", files };
  return projectGist(g, 1_000_000).files.map((f) => f.filename);
}

describe("projectGist file order is by code point, not host collation (#243)", () => {
  it("orders ASCII case, punctuation and a non-ASCII letter by code point", () => {
    expect(order(["z.md", "ä.md", "B.md", "a.md", "_x.md"])).toEqual([
      "B.md",
      "_x.md",
      "a.md",
      "z.md",
      "ä.md",
    ]);
  });

  it("puts an astral character after U+E000-U+FFFF (code points, not UTF-16 units)", () => {
    expect(order(["\u{1F600}.md", ".md"])).toEqual([".md", "\u{1F600}.md"]);
  });

  it("orders NFC and NFD spellings of one name the same way whatever order the API lists them", () => {
    const nfc = "é.md";
    const nfd = "é.md";
    // Collation calls the two equal, so their order was the API's order.
    expect(order([nfc, nfd])).toEqual([nfd, nfc]);
    expect(order([nfd, nfc])).toEqual([nfd, nfc]);
  });

  it("compareCodePoints: equal is 0, a proper prefix sorts first", () => {
    expect(compareCodePoints("a.md", "a.md")).toBe(0);
    expect(compareCodePoints("a", "a.md")).toBeLessThan(0);
    expect(compareCodePoints("a.md", "a")).toBeGreaterThan(0);
  });
});
