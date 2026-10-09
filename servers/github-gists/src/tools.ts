/**
 * Tool implementations for the github-gists MCP server.
 *
 * Each tool is a thin wrapper around `GistsClient`. The tool layer's
 * job is shape conversion: argument validation, response trimming
 * (so a 4 MB gist doesn't blow the MCP response budget), and the
 * narrow projection of fields the client actually needs.
 */

import type { GistsClient, Gist } from "./client.js";

export interface ToolDeps {
  client: GistsClient;
  /** Per-file content cap when returning a gist. Files larger than this
   *  are surfaced with `truncated: true` and the content omitted. */
  maxBytesPerFile: number;
}

const DEFAULT_MAX_BYTES_PER_FILE = 100_000;

export function defaultToolDeps(client: GistsClient): ToolDeps {
  return { client, maxBytesPerFile: DEFAULT_MAX_BYTES_PER_FILE };
}

export interface ProjectedGistFile {
  filename: string;
  size: number | null;
  language: string | null;
  truncated: boolean;
  content: string | null;
}

export interface ProjectedGist {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  files: ProjectedGistFile[];
}

/**
 * Project a raw API `Gist` down to the response shape we hand back
 * through MCP. Drops the noisy fields (history, comments_url, etc.)
 * and applies the per-file content cap.
 */
export function projectGist(g: Gist, maxBytesPerFile: number): ProjectedGist {
  const files: ProjectedGistFile[] = [];
  for (const [name, f] of Object.entries(g.files ?? {})) {
    const content = typeof f.content === "string" ? f.content : null;
    const size = typeof f.size === "number" ? f.size : content !== null ? Buffer.byteLength(content, "utf-8") : null;
    const overCap = content !== null && Buffer.byteLength(content, "utf-8") > maxBytesPerFile;
    files.push({
      filename: name,
      size,
      language: f.language ?? null,
      truncated: overCap || Boolean(f.truncated),
      content: overCap ? null : content,
    });
  }
  // By code point (#243), the order filesystem-sandbox's `list_directory` uses
  // since #209. `localeCompare` collated by the HOST locale: `ä.md` sorted
  // before `B.md` under en_US and after `z.md` under sv_SE, so one gist came
  // back in a different order depending on where the server ran.
  files.sort((a, b) => compareCodePoints(a.filename, b.filename));
  return {
    id: g.id,
    description: g.description ?? null,
    public: Boolean(g.public),
    html_url: g.html_url,
    files,
  };
}

/**
 * Order two strings by Unicode code point, independent of the host locale.
 *
 * Not `<`: JavaScript compares UTF-16 code units, which puts an astral
 * character (a surrogate pair, 0xD800-0xDBFF) before U+E000-U+FFFF while code
 * point order puts it after. A copy of filesystem-sandbox's helper, not an
 * import: the servers share no runtime (D-002).
 */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

export async function getGist(deps: ToolDeps, gistId: string): Promise<ProjectedGist> {
  const raw = await deps.client.getGist(gistId);
  return projectGist(raw, deps.maxBytesPerFile);
}

export async function updateGistFile(
  deps: ToolDeps,
  args: { gist_id: string; filename: string; content: string; description?: string },
): Promise<ProjectedGist> {
  const raw = await deps.client.updateGistFile({
    gistId: args.gist_id,
    filename: args.filename,
    content: args.content,
    description: args.description,
  });
  return projectGist(raw, deps.maxBytesPerFile);
}
