//
// Comment-stripping for the `tools/` source checkers, in one place (#170).
//
// Two checkers needed this and #169 fixed only one of them. That was not an
// oversight so much as a reason that stopped being true: the string checker's
// own docstring explains why comment-only stripping had been fine there --
//
//     That is conservative for a "this must not appear" check (leaving comment
//     text in only ever makes it flag MORE), which is why it was fine for the
//     two rules below.
//
// -- and that is a statement about the DIRECTION of those rules. Every rule in
// `check-numeric-env-grammar.mjs` points the other way: they are all "must be
// PRESENT" (gate on the grammar, bound with BigInt, trim before gating), so
// leaving comment text in makes it flag FEWER. Measured on one ungated
// function, twice:
//
//     ungated coercion                                    violations=3
//     IDENTICAL code + trailing comments naming the rules violations=1
//
// The comments that did it were "we used to gate on ..." and "the old code
// called raw.trim() first" -- which is what someone writes WHILE REMOVING A
// GUARD, so the false pass lands exactly when the checker is needed.
//
// A true reason for a narrow rule is still a reason that does not cover the
// sibling. Sharing the definition is what stops the next one inheriting it:
// #169 measured, in this same repo, that two identical copies agree by
// construction, so only a structural arm catches a re-paste.
//
// Lifted verbatim from `check-string-env-grammar.mjs` rather than rewritten, so
// the shared definition is byte-identical to the one #169 reviewed.

/** Strip comments so prose *describing* the old shape is not read as code. */
export function stripComments(src) {
  return stripLineComments(src.replace(/\/\*[\s\S]*?\*\//g, ""));
}

/**
 * Remove `//` comments, including ones that TRAIL code on the same line.
 *
 * The previous rule matched comment-only lines: a line-start anchor, optional
 * whitespace, then a double slash. That is conservative
 * for a "this must not appear" check (leaving comment text in only ever makes
 * it flag MORE), which is why it was fine for the two rules below. It is not
 * fine for the coverage arm added in #168, which asks whether a setting name
 * appears AT ALL: a name mentioned in a trailing comment was reported as an
 * uncovered access, and a check that fails on correct code is worse than no
 * check -- this repo says so in three separate files.
 *
 * Quote-aware, because `github-gists` has
 * `const DEFAULT_BASE = "https://api.github.com"` and a naive scan for `//`
 * truncates that line at the protocol separator. Tracking quote state is what
 * distinguishes a comment from a URL; a `:` lookbehind would be a proxy for the
 * question, and this repo's notes are explicit that a wrong proxy fails on
 * correct code.
 *
 * Template literals count as quotes. Their `${...}` interpolations cannot carry
 * a `//` comment in any code this scan looks at, and modelling that nesting
 * would be a JS parser.
 */
export function stripLineComments(src) {
  return src
    .split("\n")
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === "\\") i++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
          continue;
        }
        if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}
