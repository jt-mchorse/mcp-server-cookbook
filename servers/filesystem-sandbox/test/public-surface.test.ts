/**
 * Public-surface tests for `package.json` ↔ `src/server.ts`.
 *
 * Each TS server in this cookbook is a script, not a library — there
 * is no aggregator `src/index.ts` to anchor `import * as Index`. The
 * meaningful public surface here is the package.json contract that
 * downstream consumers (`mcp-filesystem-sandbox` CLI, MCP-client
 * `command:` configs) depend on:
 *
 * - `package.json#version` (TS analog of `__version__`).
 * - `package.json#main` → the entry point downstream `import`s see.
 * - `package.json#bin.<name>` → the CLI script the operator runs.
 *
 * All three point into `dist/`, which doesn't exist at test time (the
 * `test` job runs without an `npm run build` step). We verify the
 * pre-build source-of-truth file the build emits from — `dist/server
 * .js` maps to `src/server.ts` via tsconfig `rootDir=src`/`outDir=dist`.
 *
 * `src/server.ts` is intentionally NOT smoke-imported — it has a
 * top-level `main().catch(...)` that starts the MCP stdio transport
 * on import, so dynamic-importing in a test would actually try to
 * start the server.
 *
 * Thirteenth strike of the portfolio-wide public-surface hygiene
 * pattern; first multi-package strike (one PR adds this test to all
 * four TS servers in this cookbook).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

interface PackageJson {
  readonly version?: unknown;
  readonly main?: unknown;
  readonly bin?: Record<string, unknown>;
}

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as PackageJson;
}

function mapDistToSource(distPath: string): string {
  // dist/server.js → src/server.ts via tsconfig rootDir=src, outDir=dist.
  return distPath
    .replace(/^\.\//, "")
    .replace(/^dist\//, "src/")
    .replace(/\.js$/, ".ts");
}

describe("public surface — package.json#version", () => {
  it("is set to a semver-ish string", () => {
    const pkg = loadPackageJson();
    expect(pkg.version, "package.json#version is missing").toBeDefined();
    expect(typeof pkg.version).toBe("string");
    const version = pkg.version as string;
    expect(version, "package.json#version is empty").not.toBe("");
    expect(
      SEMVER_PATTERN.test(version),
      `package.json#version = ${JSON.stringify(version)} doesn't look like semver`,
    ).toBe(true);
  });
});

describe("public surface — package.json#main pre-build source", () => {
  it("maps to a real pre-build source file via tsconfig rootDir/outDir", () => {
    const pkg = loadPackageJson();
    const main = pkg.main;
    expect(main, "package.json#main is missing").toBeDefined();
    expect(typeof main).toBe("string");

    const distPath = main as string;
    expect(
      distPath.startsWith("dist/") || distPath.startsWith("./dist/"),
      `package.json#main = ${JSON.stringify(distPath)} should start with "dist/" (tsconfig outDir)`,
    ).toBe(true);

    const sourceRelative = mapDistToSource(distPath);
    const sourceAbsolute = resolve(ROOT, sourceRelative);
    expect(
      existsSync(sourceAbsolute),
      `package.json#main points to ${JSON.stringify(distPath)}, which maps to ` +
        `source ${JSON.stringify(sourceRelative)} — but that file does not exist. ` +
        "Update package.json#main to match the actual entry source.",
    ).toBe(true);
  });
});

describe("public surface — package.json#bin pre-build source", () => {
  it("every bin entry maps to a real pre-build source file", () => {
    const pkg = loadPackageJson();
    const bin = pkg.bin ?? {};
    const entries = Object.entries(bin);
    expect(
      entries.length,
      "package.json#bin is empty — the CLI entry-point this README documents would silently break",
    ).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [name, target] of entries) {
      if (typeof target !== "string") {
        missing.push(`${name} (target is not a string: ${JSON.stringify(target)})`);
        continue;
      }
      const sourceRelative = mapDistToSource(target);
      const sourceAbsolute = resolve(ROOT, sourceRelative);
      if (!existsSync(sourceAbsolute)) {
        missing.push(
          `${name} → ${target} → ${sourceRelative} (source file does not exist)`,
        );
      }
    }
    expect(
      missing,
      `package.json#bin entries with missing pre-build sources: ${missing.join("; ")}. ` +
        "Update package.json#bin to match the actual source paths.",
    ).toEqual([]);
  });
});
