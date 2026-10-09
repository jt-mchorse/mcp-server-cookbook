//
// "Was this module run directly?" for every `tools/` entry point, in one place
// (#245).
//
// Each checker used to answer it inline, three ways:
//
//   import.meta.url === `file://${process.argv[1]}`                 (12 files)
//   process.argv[1] === fileURLToPath(import.meta.url)               (1)
//   path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) (2)
//
// `import.meta.url` is the module's REALPATH, and the first form also compares
// it URL-ENCODED; `argv[1]` is the path as typed, made absolute and nothing
// else. So a checkout reached through a symlink (macOS `/tmp` is
// `/private/tmp`) failed all three, and one under a directory with a space
// (`%20` vs ` `) failed the first twelve. A false guard does not error: the
// script defines its functions, runs nothing, and exits 0 -- a gate that
// reports success having checked nothing (sibling of
// ai-app-integration-tests#169). CI's runner path has neither, which is why it
// stayed green.
//
// Both sides go through `realpathSync`, so the comparison is between two
// canonical filesystem paths. It never throws: an absent or unresolvable
// `argv[1]` (the module was imported, or run from `node -e`) is simply "not
// main".

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module whose `import.meta.url` is given is the script Node was
 * asked to run.
 *
 * @param {string} importMetaUrl the caller's `import.meta.url`
 * @param {string | undefined} [argv1] defaults to `process.argv[1]`; a
 *   parameter only so the tests can exercise it without spawning
 */
export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
