//
// The shared comment-stripper (#170).
//
// #169 widened this in `check-string-env-grammar.mjs` and left
// `check-numeric-env-grammar.mjs` on the old comment-only rule. That was not
// carelessness: the string checker's docstring explains why the old rule had
// been fine there --
//
//     That is conservative for a "this must not appear" check (leaving comment
//     text in only ever makes it flag MORE), which is why it was fine for the
//     two rules below.
//
// -- and that is a claim about the DIRECTION of those rules. Every rule in the
// numeric checker points the other way: all three are "must be PRESENT", so
// leaving comment text in makes it flag FEWER. A true reason for a narrow rule
// is still a reason that does not cover the sibling.
//
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { stripComments, stripLineComments } from "./strip-comments.mjs";
import { REPO_ROOT, TOOLS_DIR, isModule, toolsFiles } from "./tools-files.mjs";

/**
 * This module, as the walk reports it. The exemption in the scan below is this
 * constant and not a basename, so renaming the file breaks the test loudly
 * instead of silently widening what the scan forgives.
 */
const CANONICAL = "tools/lib/strip-comments.mjs";

/** This test file, as the walk reports it. */
const SELF = "tools/lib/strip-comments.test.mjs";

test("a trailing comment is removed", () => {
  assert.equal(
    stripComments("const x = 1; // gate on the grammar").trim(),
    "const x = 1;",
  );
});

test("a comment-only line is removed", () => {
  assert.equal(
    stripComments("  // gone\nconst x = 1;\n").trim(),
    "const x = 1;",
  );
});

test("a block comment is removed", () => {
  assert.equal(stripComments("/* gone */const x = 1;").trim(), "const x = 1;");
});

test("a URL inside a string survives — the quote-awareness control from #169", () => {
  // `github-gists` has exactly this line. A naive `//` scan truncates it at the
  // protocol separator, and a check that fails on correct code is worse than no
  // check — this repo says so in three separate files.
  const line = 'const DEFAULT_BASE = "https://api.github.com";';
  assert.equal(stripComments(line), line);
});

test("single quotes and template literals count as quotes", () => {
  for (const q of ['"', "'", "`"]) {
    const line = `const u = ${q}https://x.example${q};`;
    assert.equal(stripLineComments(line), line, `quote ${q}`);
  }
});

test("an escaped quote does not end the string early", () => {
  const line = 'const s = "a \\" // not a comment";';
  assert.equal(stripLineComments(line), line);
});

test("a comment AFTER a string on the same line is still removed", () => {
  assert.equal(
    stripLineComments('const u = "https://x.example"; // and this goes').trim(),
    'const u = "https://x.example";',
  );
});

// --- the reason this module exists, as a test ---------------------------

test("the old comment-only rule would leave a trailing comment behind", () => {
  // The rule both checkers used to carry. Kept here as the comparison the
  // decision was made against, and NOT exported, so nothing can reach for it.
  const commentOnly = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const line = "const raw = env.X; // we used to gate on the grammar here";
  assert.match(
    commentOnly(line),
    /gate on the grammar/,
    "the premise of #170 has changed",
  );
  assert.doesNotMatch(stripComments(line), /gate on the grammar/);
});

// --- one definition -----------------------------------------------------

test("no tool declares its own stripComments", () => {
  // #169 measured, in this repo, that two identical copies agree by
  // construction — so only a structural arm catches the next re-paste. A
  // `export { stripComments }` re-export is not a declaration and is allowed:
  // both grammar checkers re-export so their own test files keep importing
  // from them.
  //
  // RECURSIVE since #174. This walked `readdirSync(TOOLS_DIR)` one level deep,
  // so it saw 27 of 29 `.mjs` files and **never inspected the module it is
  // about** -- the canonical `tools/lib/strip-comments.mjs` was one of the two
  // it missed. A re-paste under `tools/lib/` was invisible to the one arm
  // written to catch a re-paste, and `tools/lib/` exists because of #170, the
  // change that added this arm.
  const offenders = [];
  // The corpus this scan actually walked, asserted below. Recorded here
  // rather than recomputed in a neighbouring arm: a corpus comparison that
  // builds its own lists stays GREEN when THIS loop is reverted to a flat
  // walk -- measured, 0 red -- because it never touches the scan it is
  // about. `offenders` cannot be the separator either: both hit sets are
  // empty today, which is exactly why the defect was invisible.
  const scanned = [];
  for (const rel of toolsFiles(isModule)) {
    scanned.push(rel);
    // Exempt by PATH, because this module *is* the definition -- it genuinely
    // declares `export function stripComments`, and a recursive walk sees it
    // for the first time (#174). Not by basename and not by a substring: a
    // text-keyed exemption is a wildcard that goes on exempting whatever
    // resembles the string after the helper is renamed or a second file with a
    // similar name arrives.
    if (rel === CANONICAL) continue;
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    if (/^\s*(export\s+)?function strip(Comments|LineComments)\b/m.test(text)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these tools declare their own comment-stripper instead of importing ` +
      `tools/lib/strip-comments.mjs: ${offenders.join(", ")}`,
  );
  // The assertion that goes red on a flat walk. `offenders` never can.
  assert.ok(
    scanned.includes(CANONICAL),
    `the scan never inspected ${CANONICAL} -- it walked ${scanned.length} ` +
      `files and tools/lib/ was not among them, which is the #174 defect`,
  );
  assert.ok(
    scanned.includes(SELF),
    `the scan did not reach its own file either: ${scanned.length} walked`,
  );
});

test("the structural scan is not vacuous", () => {
  // Every assertion above is `deepEqual([], ...)`, which a scan reading no
  // files would also satisfy. Prove it reads the tools and that its pattern
  // matches a real declaration.
  const names = toolsFiles(isModule);
  assert.ok(names.length >= 25, `the tools scan found ${names.length} files`);
  // The floor is not the point; the CORPUS is. `>= 10` was satisfied by the
  // flat walk that could not see `tools/lib/` at all, which is how this arm
  // certified a broken discovery as non-vacuous for two issues (#174). Assert
  // the directory every one of #168/#170/#172/#173 was about is actually in it.
  assert.ok(
    names.includes(CANONICAL),
    `the scan did not reach tools/lib/, so it never inspected the module this ` +
      `arm is about: ${names}`,
  );
  const declaration =
    "export function stripComments(src) {\n  return src;\n}\n";
  assert.match(
    declaration,
    /^\s*(export\s+)?function strip(Comments|LineComments)\b/m,
  );
  // And a re-export must NOT match, or the test above would be unsatisfiable.
  assert.doesNotMatch(
    "export { stripComments };",
    /^\s*(export\s+)?function strip(Comments|LineComments)\b/m,
  );
});

test("a flat walk would not reach this module (the defect, run)", () => {
  // **The separating arm, and it has to be about the CORPUS rather than the
  // offenders.** Both hit sets are empty today -- the flat walk found no
  // offenders and so does the recursive one -- so an assertion about
  // `offenders` stays green against the revert. What changed is *what was
  // looked at*: 27 files of 29, with the canonical module among the two missed.
  //
  // Reproduced against the real tree rather than a fixture, because the claim
  // is about this repo's own layout: `tools/lib/` exists, and a one-level scan
  // cannot see into it.
  const flat = readdirSync(TOOLS_DIR).filter(isModule);
  const recursive = toolsFiles(isModule).map((rel) =>
    rel.slice("tools/".length),
  );
  assert.ok(
    recursive.length > flat.length,
    "if these agree, tools/lib/ has gone away and this arm no longer separates the two walks",
  );
  const missed = recursive.filter((n) => !flat.includes(n));
  assert.ok(
    missed.includes("lib/strip-comments.mjs"),
    `a flat walk should miss the canonical module; it missed ${missed}`,
  );
  // And the whole point: the module this arm is about is in one corpus, not the
  // other.
  assert.ok(!flat.includes("lib/strip-comments.mjs"));
});

test("the canonical module is exempted by path, not by name", () => {
  // A text-keyed exemption is a wildcard: `name.includes("strip-comments")`
  // would also forgive a `strip-comments-v2.mjs` that re-pasted the function,
  // and would stop forgiving anything the moment the helper is renamed. Three
  // repos have been bitten by exemption-by-text this quarter.
  assert.equal(CANONICAL, "tools/lib/strip-comments.mjs");
  assert.ok(
    CANONICAL.includes("/"),
    "the exemption must be a path, not a basename",
  );
  // Asserted over the SOURCE of the exemption, not over the constant. A first
  // draft only checked `CANONICAL`, and swapping the guard to
  // `rel.endsWith("strip-comments.mjs")` or `rel.includes("strip-comments")`
  // left it GREEN -- measured, 0 red for both. The constant is not the thing
  // that does the exempting.
  const own = stripComments(readFileSync(join(REPO_ROOT, SELF), "utf8"));
  assert.match(
    own,
    /if \(rel === CANONICAL\) continue;/,
    "the exemption must be an equality against the canonical PATH",
  );
  assert.ok(
    !/rel\.(endsWith|includes|startsWith)\(\s*["\x27`][^"\x27`]*strip-comments/.test(
      own,
    ),
    "the exemption must not be keyed on a name fragment: that would also " +
      "forgive a strip-comments-v2.mjs that re-pasted the function, and would " +
      "stop forgiving anything the moment the helper is renamed",
  );
  // The exemption must name a file that exists, or it forgives nothing and the
  // scan flags the definition.
  assert.ok(
    toolsFiles(isModule).includes(CANONICAL),
    `${CANONICAL} is not in the walk`,
  );
  // And it must be needed: the module really does declare the function, which
  // is why a recursive walk without the exemption fails.
  const text = readFileSync(join(REPO_ROOT, CANONICAL), "utf8");
  assert.match(text, /^\s*export function stripComments\b/m);
});

test("no other tools file walks tools/ one level deep", () => {
  // The deferred half of #174, asserted rather than left in prose so the next
  // sweep of this class reads a result. Every other `readdirSync` in `tools/`
  // walks `servers/` or `.github/workflows/` -- a different population, where
  // `tools/lib/` is not a member and one level is the whole depth.
  const offenders = [];
  for (const rel of toolsFiles(isModule)) {
    // This file is exempt by PATH and by COUNT, not blanket-exempt: the
    // falsification arm above calls the flat walk on purpose, to show it cannot
    // reach `tools/lib/`. Same precedent as the registration lock, whose own
    // fixture walk is accounted for rather than ignored. Exempting the whole
    // file would let a real flat scan hide next to the deliberate one.
    if (rel === SELF) continue;
    const code = stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"));
    if (/readdirSync\(\s*TOOLS_DIR/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files scan tools/ one level deep, which cannot see tools/lib/: ` +
      `${offenders.join(", ")}. Use toolsFiles() from tools/lib/tools-files.mjs.`,
  );
  const own = stripComments(readFileSync(join(REPO_ROOT, SELF), "utf8"));
  assert.equal(
    (own.match(/readdirSync\(\s*TOOLS_DIR/g) ?? []).length,
    1,
    "this file may contain exactly one flat scan of tools/, the falsification arm",
  );
});

test("both grammar checkers import it and neither re-implements it", () => {
  for (const name of [
    "check-string-env-grammar.mjs",
    "check-numeric-env-grammar.mjs",
  ]) {
    const text = readFileSync(join(TOOLS_DIR, name), "utf8");
    assert.match(
      text,
      /from "\.\/lib\/strip-comments\.mjs"/,
      `${name} does not import it`,
    );
  }
});
