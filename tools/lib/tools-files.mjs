//
// Recursive discovery of `tools/` files, in one place (#174).
//
// #172 parameterised this walk after finding two discoveries in ONE file that
// disagreed -- a recursive test scan and, fifty lines below the comment
// explaining why recursion was needed, a flat `readdirSync(TOOLS_DIR)`. #173
// closed the second. Both fixes lived inside
// `check-tools-test-registration.test.mjs`, where the function was a private
// `function toolsFiles(...)`.
//
// So when `tools/lib/strip-comments.test.mjs` needed the same population, the
// only two options were a third copy of the walk or this module. A third copy
// is the copy-instead-of-share shape #170 fixed for `stripComments` -- and it
// would have been pasted into the file whose own arm is "no tool declares its
// own stripComments", which is self-refuting.
//
// The class this closes has now been paid for five times (#168's one-level
// scan, #170's recursion, #172, #173, and nextjs-streaming-ai-patterns #122 and
// #123). Every one of them is "a walk that did not reach `tools/lib/`", and the
// reason the same directory keeps being missed is that a flat `readdirSync` is
// the shorter thing to write. One exported definition is what stops the sixth.

import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** `<repo>/tools`, resolved from this module's own location. */
export const TOOLS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The repository root. */
export const REPO_ROOT = dirname(TOOLS_DIR);

/**
 * Every file under `tools/` matching `predicate(basename)`, recursively, as a
 * repo-relative POSIX path, sorted.
 *
 * `dir` exists so a falsification arm can run the same walk over a synthetic
 * tree and show it separates from a flat one. That is the only reason it is a
 * parameter, and it is why the arms that use it must ALSO assert the real call
 * sites: a walk proven capable on a fixture says nothing about where it is
 * called, which is the defect #172 was.
 */
export function toolsFiles(predicate, dir = TOOLS_DIR) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...toolsFiles(predicate, abs));
      continue;
    }
    if (predicate(name))
      out.push(relative(REPO_ROOT, abs).split("\\").join("/"));
  }
  return out.sort();
}

/** A `tools/` test file. */
export const isTestFile = (name) => name.endsWith(".test.mjs");

/** Any `tools/` JavaScript module, test files included. */
export const isModule = (name) => name.endsWith(".mjs");
