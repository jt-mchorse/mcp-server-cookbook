/**
 * The TS port enforces its published inputSchema the way the Python SDK does
 * (#197, D-014). Same table as `tests/test_tool_args_parity.py`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkToolArgs, type ToolInputSchema } from "../src/tool-args.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = path.resolve(HERE, "../../../test-fixtures/tool_args_parity.json");
const SERVER = path.resolve(HERE, "../src/server.ts");

interface Case {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  fragment: string | null;
}
const table = JSON.parse(readFileSync(TABLE, "utf8")) as { cases: Case[] };

/** The published schemas, read from server.ts (it starts a server on import). */
function publishedSchemas(): Record<string, ToolInputSchema> {
  const src = readFileSync(SERVER, "utf8");
  const start = src.indexOf("const TOOLS = [");
  const end = src.indexOf("];", start);
  const tools = new Function(`return ${src.slice(start + "const TOOLS = ".length, end + 1)}`)() as {
    name: string;
    inputSchema: ToolInputSchema;
  }[];
  return Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
}

describe("tool-args parity table (#197)", () => {
  const schemas = publishedSchemas();

  it("reads every published tool (non-zero control)", () => {
    expect(Object.keys(schemas).sort()).toEqual(["list_directory", "read_file", "write_file"]);
    expect(table.cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(table.cases)("$label", ({ tool, args, fragment }) => {
    const result = checkToolArgs(schemas[tool]!, args);
    if (fragment === null) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
      expect(result).toContain("Input validation error: ");
      expect(result).toContain(fragment);
    }
  });
});

describe("checkToolArgs edges", () => {
  const schema: ToolInputSchema = {
    type: "object",
    properties: { path: { type: "string" }, depth: { type: "integer" } },
    required: ["path"],
    additionalProperties: false,
  };

  it("treats absent arguments as {}", () => {
    expect(checkToolArgs({ type: "object" }, undefined)).toBeNull();
    expect(checkToolArgs(schema, undefined)).toContain("'path' is a required property");
  });

  it.each([[[1]], ["s"], [5]])("refuses non-object arguments %j", (args) => {
    expect(checkToolArgs(schema, args)).toContain("is not of type 'object'");
  });

  it.each([[2.5], ["3"], [true], [null]])("refuses a non-integer %j for an integer", (depth) => {
    expect(checkToolArgs(schema, { path: "/x", depth })).toContain("is not of type 'integer'");
  });

  it("accepts an integer, and leaves ranges to the handler", () => {
    expect(checkToolArgs(schema, { path: "/x", depth: 99 })).toBeNull();
  });

  it("does not police properties when additionalProperties is not false", () => {
    expect(checkToolArgs({ type: "object", properties: {} }, { anything: 1 })).toBeNull();
  });
});
