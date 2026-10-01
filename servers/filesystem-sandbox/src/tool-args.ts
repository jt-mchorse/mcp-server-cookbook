/**
 * Enforce a tool's published `inputSchema` before the handler reads its
 * `arguments` (#197, D-014).
 *
 * Every TS server here publishes `additionalProperties: false` and typed
 * properties, and none of them enforced it: the TS SDK does not validate
 * `inputSchema`, so the handlers cast `arguments` to a record and read fields
 * off it. Measured on filesystem-sandbox, `read_file {path, max_bytes: 1}`
 * succeeded and returned the WHOLE file, ignoring the caller's cap, and
 * `{path: 5}` was refused as `sandbox_escape (input_empty)` -- while the Python
 * port, whose SDK validates with jsonschema, refused both with
 * `Input validation error: ...`. The README calls the two ports' tool surfaces
 * the same; the published half was, the enforced half was not.
 *
 * This checks the subset of JSON Schema these tools publish -- an object with
 * `required`, `additionalProperties: false`, and `string` / `integer` property
 * types -- and words its messages the way jsonschema does, so both ports
 * refuse the same input with the same reason
 * (`test-fixtures/tool_args_parity.json`). Ranges (`minimum` / `maximum`) stay
 * in the handlers, which already validate them.
 *
 * This file is copied, byte for byte, into every TS server's `src/`;
 * `tools/check-tool-args.mjs` fails if the copies drift or if a server's
 * CallTool handler stops calling `checkToolArgs`.
 */

export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, { type?: string }>;
  required?: string[];
  additionalProperties?: boolean;
}

const hasOwn = (o: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, key);

function show(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      // A type this checker does not model is not refused here.
      return true;
  }
}

/**
 * `null` when `args` satisfies `schema`, otherwise the refusal text.
 *
 * Absent `arguments` is treated as `{}`, which is what the handlers did, so a
 * tool with no required property still accepts a bare call.
 */
export function checkToolArgs(schema: ToolInputSchema, args: unknown): string | null {
  const a = args ?? {};
  if (!matchesType(a, "object")) {
    return `Input validation error: ${show(a)} is not of type 'object'`;
  }
  const obj = a as Record<string, unknown>;
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!hasOwn(obj, key)) {
      return `Input validation error: '${key}' is a required property`;
    }
  }
  if (schema.additionalProperties === false) {
    const extras = Object.keys(obj).filter((key) => !hasOwn(properties, key));
    if (extras.length > 0) {
      const names = extras.map((key) => `'${key}'`).join(", ");
      const verb = extras.length === 1 ? "was" : "were";
      return `Input validation error: Additional properties are not allowed (${names} ${verb} unexpected)`;
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (hasOwn(obj, key) && spec.type !== undefined && !matchesType(obj[key], spec.type)) {
      return `Input validation error: ${show(obj[key])} is not of type '${spec.type}'`;
    }
  }
  return null;
}
