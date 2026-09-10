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

const TOOLS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

test("a trailing comment is removed", () => {
  assert.equal(stripComments("const x = 1; // gate on the grammar").trim(), "const x = 1;");
});

test("a comment-only line is removed", () => {
  assert.equal(stripComments("  // gone\nconst x = 1;\n").trim(), "const x = 1;");
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
  assert.match(commentOnly(line), /gate on the grammar/, "the premise of #170 has changed");
  assert.doesNotMatch(stripComments(line), /gate on the grammar/);
});

// --- one definition -----------------------------------------------------

test("no tool declares its own stripComments", () => {
  // #169 measured, in this repo, that two identical copies agree by
  // construction — so only a structural arm catches the next re-paste. A
  // `export { stripComments }` re-export is not a declaration and is allowed:
  // both grammar checkers re-export so their own test files keep importing
  // from them.
  const offenders = [];
  for (const name of readdirSync(TOOLS_DIR)) {
    if (!name.endsWith(".mjs")) continue;
    const text = readFileSync(join(TOOLS_DIR, name), "utf8");
    if (/^\s*(export\s+)?function strip(Comments|LineComments)\b/m.test(text)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these tools declare their own comment-stripper instead of importing ` +
      `tools/lib/strip-comments.mjs: ${offenders.join(", ")}`,
  );
});

test("the structural scan is not vacuous", () => {
  // Every assertion above is `deepEqual([], ...)`, which a scan reading no
  // files would also satisfy. Prove it reads the tools and that its pattern
  // matches a real declaration.
  const names = readdirSync(TOOLS_DIR).filter((n) => n.endsWith(".mjs"));
  assert.ok(names.length >= 10, `the tools scan found ${names.length} files`);
  const declaration = "export function stripComments(src) {\n  return src;\n}\n";
  assert.match(declaration, /^\s*(export\s+)?function strip(Comments|LineComments)\b/m);
  // And a re-export must NOT match, or the test above would be unsatisfiable.
  assert.doesNotMatch(
    "export { stripComments };",
    /^\s*(export\s+)?function strip(Comments|LineComments)\b/m,
  );
});

test("both grammar checkers import it and neither re-implements it", () => {
  for (const name of ["check-string-env-grammar.mjs", "check-numeric-env-grammar.mjs"]) {
    const text = readFileSync(join(TOOLS_DIR, name), "utf8");
    assert.match(text, /from "\.\/lib\/strip-comments\.mjs"/, `${name} does not import it`);
  }
});
