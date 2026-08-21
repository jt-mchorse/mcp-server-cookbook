/**
 * `Sandbox.resolve` parity with the Python port (#141).
 *
 * Three parity fixes preceded this one — #98 (grammar), #137 (value domain),
 * #139 (trim charset) — and **all three landed in `config`**. `sandbox`, where
 * the security property actually lives, had never been probed side by side,
 * and the test suite showed the same gap: a `config-trim-parity` pair and a
 * `max-bytes-parity` pair, no sandbox pair.
 *
 * Running one identical case table through both ports found 3 divergences in
 * 15 cases. None was an allow-list escape — containment held everywhere — but
 * all three were contract disagreements in an exported API:
 *
 * 1. A **dangling symlink pointing inside a root** was accepted by Python
 *    under `must_exist=True`, because `os.path.lexists` does not follow
 *    symlinks. The `must_exist=True` sibling of #60, whose `mustExist=false`
 *    branch *is* covered in both ports.
 * 2. A path whose **parent is a regular file** was accepted *here*, because
 *    `fs.realpath` succeeds on a file — a write then failed with a raw
 *    `ENOTDIR` instead of the typed error the threat model promises.
 * 3. A **trailing separator on a file** was rejected by both, but for
 *    different reasons and by accident: this port depended on whether the
 *    host's `realpath` happened to be lenient (darwin's was).
 *
 * The table lives in `test-fixtures/sandbox_parity.json` and is read by BOTH
 * suites, so the ports are exercised against literally the same inputs rather
 * than two hand-maintained copies that can drift apart the way the
 * implementations did.
 *
 * Every row asserts the **resolved path** on accept and the **reason** on
 * reject, not just accept/reject. The trailing-separator row is exactly why:
 * it passes an accept/reject-only check on the broken tree, because both ports
 * rejected it — they just disagreed about what to call it.
 */

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sandbox, SandboxEscape } from "../src/sandbox.js";

interface ParityCase {
  label: string;
  note?: string;
  path: string;
  must_exist: boolean;
  expect: "ok" | "escape";
  resolved?: string;
  reason?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(HERE, "..", "..", "..", "test-fixtures", "sandbox_parity.json");

const table = JSON.parse(readFileSync(TABLE_PATH, "utf8")) as {
  allowlist: string[];
  tree: {
    dirs: string[];
    files: Record<string, string>;
    symlinks: { link: string; target: string }[];
  };
  cases: ParityCase[];
};

let base: string;
let sandbox: Sandbox;

beforeEach(async () => {
  // `realpathSync` so the base matches what `resolve` will canonicalize to —
  // on darwin `os.tmpdir()` is itself a symlink into /private.
  base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-parity-")));
  for (const d of table.tree.dirs) mkdirSync(join(base, d), { recursive: true });
  for (const [rel, content] of Object.entries(table.tree.files)) {
    writeFileSync(join(base, rel), content);
  }
  for (const l of table.tree.symlinks) symlinkSync(join(base, l.target), join(base, l.link));
  sandbox = await Sandbox.create(table.allowlist.map((r) => join(base, r)));
});

afterEach(() => {
  base = "";
});

/**
 * Turn a fixture `path` into the string handed to `resolve`.
 *
 * Two escapes keep the shared table language-neutral: `!literal:` passes the
 * remainder through untouched (the empty-input row) and `!relative:` marks a
 * deliberately relative path.
 *
 * Deliberate string concatenation rather than `join`: `path.join` normalizes,
 * and the "trailing separator on a file" row would silently lose the very
 * character it exists to test. The Python side had exactly this bug in its
 * first draft and the row caught it.
 */
function inputFor(c: ParityCase): string {
  if (c.path.startsWith("!literal:")) return c.path.slice("!literal:".length);
  if (c.path.startsWith("!relative:")) return c.path.slice("!relative:".length);
  return base.replace(new RegExp(`${sep}+$`), "") + sep + c.path;
}

describe("sandbox resolve parity (#141)", () => {
  it("loads a non-empty shared table", () => {
    // Guards the guard: a fixture that failed to load would make every case
    // below vanish and the suite would look green.
    expect(table.cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const c of table.cases) {
    it(`${c.label}`, async () => {
      const target = inputFor(c);
      if (c.expect === "ok") {
        const sp = await sandbox.resolve(target, { mustExist: c.must_exist });
        expect(sp.resolved, c.note ?? "").toBe(join(base, c.resolved as string));
      } else {
        await expect(
          sandbox.resolve(target, { mustExist: c.must_exist }),
          c.note ?? "",
        ).rejects.toThrow(SandboxEscape);
        let reason: string | undefined;
        try {
          await sandbox.resolve(target, { mustExist: c.must_exist });
        } catch (e) {
          reason = (e as SandboxEscape).reason;
        }
        expect(reason, c.note ?? "").toBe(c.reason);
      }
    });
  }

  it("mustExist=true never returns a non-existent path", async () => {
    // The contract `mustExist` is named for — stated as a property, because
    // the input that broke it in Python (a dangling symlink) is not the only
    // way to reach it.
    const { existsSync } = await import("node:fs");
    for (const c of table.cases) {
      if (!c.must_exist || c.expect !== "ok") continue;
      const sp = await sandbox.resolve(inputFor(c), { mustExist: true });
      expect(existsSync(sp.resolved), `${c.label}: ${sp.resolved} does not exist`).toBe(true);
    }
  });

  it("containment still holds — none of the #141 fixes weakened the allow-list", async () => {
    const outside = join(base, "outside", "secret.txt");
    await expect(sandbox.resolve(outside, { mustExist: true })).rejects.toThrow(SandboxEscape);
    await expect(sandbox.resolve(outside, { mustExist: false })).rejects.toThrow(SandboxEscape);
  });
});
