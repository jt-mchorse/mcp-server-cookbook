/**
 * The README Quickstart does what its comments say (#191).
 *
 * It copied `.env.example` to `.env`, then started the server with
 * `DATABASE_URL=... npm start`. `npm start` is `node dist/server.js`, with no
 * dotenv and no `--env-file`, so the copied file was never read: editing
 * `MAX_ROWS` in it did nothing. And `docker compose up -d` returned before this
 * compose file's `pg_isready` healthcheck passed; only `--wait` blocks on it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SERVER_DIR = resolve(__dirname, "..");
const README = readFileSync(resolve(SERVER_DIR, "README.md"), "utf-8");
const COMPOSE = readFileSync(resolve(SERVER_DIR, "docker-compose.yml"), "utf-8");

/** Every ```bash fence, as its command lines with trailing `#` comments dropped. */
function bashFences(md: string): string[][] {
  return [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) =>
    m[1]
      .split("\n")
      .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
      .filter((l) => l.length > 0),
  );
}

const LOADS_ENV = /(^|;\s*)(\.|source)\s+\.?\/?\.env(\s|;|$)|--env-file[= ]\.?\/?\.env\b/;

export function envCopyViolations(fence: string[]): string[] {
  if (!fence.some((l) => /^cp\s+\.env\.example\s+\.env$/.test(l))) return [];
  const out: string[] = [];
  if (!fence.some((l) => LOADS_ENV.test(l))) out.push("copies .env but never loads it");
  for (const l of fence) if (/(^|\s)DATABASE_URL=/.test(l)) out.push(`passes DATABASE_URL inline: ${l}`);
  return out;
}

describe("README Quickstart (#191)", () => {
  const fences = bashFences(README);

  it("finds the Quickstart fence", () => {
    // A floor, so a reworded README cannot leave the arms below checking nothing.
    expect(fences.some((f) => f.some((l) => l.startsWith("cp .env.example .env")))).toBe(true);
  });

  it("a fence that copies .env loads it and does not bypass it", () => {
    expect(fences.flatMap(envCopyViolations)).toEqual([]);
  });

  it("the rule itself: a dead copy and an inline bypass are both caught", () => {
    expect(envCopyViolations(["cp .env.example .env", "npm start"])).toEqual([
      "copies .env but never loads it",
    ]);
    expect(
      envCopyViolations(["cp .env.example .env", "set -a; . ./.env; set +a", "DATABASE_URL=x npm start"]),
    ).toEqual(["passes DATABASE_URL inline: DATABASE_URL=x npm start"]);
    expect(envCopyViolations(["cp .env.example .env", "node --env-file=.env dist/server.js"])).toEqual([]);
  });

  it("compose up waits for the healthcheck the compose file declares", () => {
    expect(COMPOSE).toContain("healthcheck:");
    const ups = fences.flat().filter((l) => /^docker compose up\b/.test(l));
    expect(ups.length).toBeGreaterThan(0);
    for (const l of ups) expect(l.split(/\s+/), l).toContain("--wait");
  });
});
