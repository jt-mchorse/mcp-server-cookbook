import { describe, it, expect } from "vitest";
import { guardQuery } from "../src/sqlGuard.js";

describe("guardQuery — allowed", () => {
  it("allows a plain SELECT", () => {
    expect(guardQuery("SELECT 1")).toEqual({ ok: true });
  });

  it("allows SELECT with whitespace and a trailing semicolon", () => {
    expect(guardQuery("  SELECT id, name FROM users WHERE active = true ;  ")).toEqual({ ok: true });
  });

  it("allows lowercase select", () => {
    expect(guardQuery("select 1")).toEqual({ ok: true });
  });

  it("allows a CTE with WITH", () => {
    expect(
      guardQuery(`
        WITH active AS (
          SELECT id FROM users WHERE active = true
        )
        SELECT * FROM active
      `),
    ).toEqual({ ok: true });
  });

  it("allows EXPLAIN SELECT (without ANALYZE)", () => {
    expect(guardQuery("EXPLAIN SELECT * FROM users")).toEqual({ ok: true });
  });

  it("allows VALUES", () => {
    expect(guardQuery("VALUES (1), (2), (3)")).toEqual({ ok: true });
  });

  it("allows a SELECT containing a string literal that looks like a write keyword", () => {
    expect(guardQuery("SELECT 'INSERT INTO foo' AS msg")).toEqual({ ok: true });
  });

  it("allows a SELECT against a column literally named delete_count", () => {
    // We don't reject identifiers that contain a forbidden substring as long as
    // it isn't a whole word.
    expect(guardQuery("SELECT delete_count FROM stats")).toEqual({ ok: true });
  });
});

describe("guardQuery — rejected (writes & DDL)", () => {
  it("rejects INSERT", () => {
    const r = guardQuery("INSERT INTO users (id) VALUES (1)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/leading keyword INSERT/);
  });

  it("rejects UPDATE", () => {
    expect(guardQuery("UPDATE users SET active = false").ok).toBe(false);
  });

  it("rejects DELETE", () => {
    expect(guardQuery("DELETE FROM users").ok).toBe(false);
  });

  it("rejects DROP", () => {
    expect(guardQuery("DROP TABLE users").ok).toBe(false);
  });

  it("rejects ALTER", () => {
    expect(guardQuery("ALTER TABLE users ADD COLUMN x INT").ok).toBe(false);
  });

  it("rejects CREATE", () => {
    expect(guardQuery("CREATE TABLE x (id INT)").ok).toBe(false);
  });

  it("rejects TRUNCATE", () => {
    expect(guardQuery("TRUNCATE users").ok).toBe(false);
  });

  it("rejects GRANT/REVOKE", () => {
    expect(guardQuery("GRANT SELECT ON users TO bob").ok).toBe(false);
    expect(guardQuery("REVOKE SELECT ON users FROM bob").ok).toBe(false);
  });
});

describe("guardQuery — rejected (multi-statement and bypass attempts)", () => {
  it("rejects two-statement input even if both are SELECTs", () => {
    const r = guardQuery("SELECT 1; SELECT 2");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multi-statement/);
  });

  it("rejects SELECT; DROP TABLE x", () => {
    expect(guardQuery("SELECT 1; DROP TABLE x").ok).toBe(false);
  });

  it("rejects a write hidden after a line comment", () => {
    const r = guardQuery("SELECT 1; -- this looks safe\nDROP TABLE x");
    expect(r.ok).toBe(false);
  });

  it("rejects a write hidden inside a block comment that was stripped", () => {
    // After comment stripping the input is `SELECT 1` (the DROP is inside the
    // block) — that's actually safe and should be ALLOWED.
    expect(guardQuery("SELECT 1 /* DROP TABLE x */").ok).toBe(true);
  });

  it("rejects SELECT followed by SET that changes the session", () => {
    expect(guardQuery("SELECT 1; SET ROLE admin").ok).toBe(false);
  });

  it("rejects pg_terminate_backend", () => {
    const r = guardQuery("SELECT pg_terminate_backend(123)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PG_TERMINATE_BACKEND/);
  });

  it("rejects EXPLAIN ANALYZE (which would execute writes if wrapped)", () => {
    expect(guardQuery("EXPLAIN ANALYZE SELECT 1").ok).toBe(false);
  });

  it("rejects FOR UPDATE row-level locks", () => {
    expect(guardQuery("SELECT * FROM users FOR UPDATE").ok).toBe(false);
  });

  it("rejects FOR SHARE row-level locks", () => {
    expect(guardQuery("SELECT * FROM users FOR SHARE").ok).toBe(false);
  });

  it("rejects DO blocks", () => {
    expect(guardQuery("DO $$ BEGIN PERFORM 1; END $$").ok).toBe(false);
  });

  it("rejects PREPARE", () => {
    expect(guardQuery("PREPARE q AS SELECT 1").ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(guardQuery("").ok).toBe(false);
    expect(guardQuery("   \n  ").ok).toBe(false);
  });

  it("rejects whitespace-only-after-comments", () => {
    expect(guardQuery("-- just a comment\n  ").ok).toBe(false);
  });

  it("rejects a leading reset/begin/commit", () => {
    expect(guardQuery("RESET ROLE").ok).toBe(false);
    expect(guardQuery("BEGIN").ok).toBe(false);
    expect(guardQuery("COMMIT").ok).toBe(false);
  });

  it("rejects a SELECT containing a CTE with INSERT INTO ... RETURNING", () => {
    // Postgres lets you do `WITH x AS (INSERT INTO ... RETURNING ...) SELECT * FROM x`
    // — that's a write, even though the leading keyword is WITH. Catch via
    // forbidden-keyword scan.
    const r = guardQuery("WITH x AS (INSERT INTO users(id) VALUES (1) RETURNING id) SELECT * FROM x");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/INSERT/);
  });
});

describe("guardQuery — semicolons inside string literals", () => {
  it("does NOT split on semicolons inside single-quoted strings", () => {
    expect(guardQuery("SELECT 'a;b;c'").ok).toBe(true);
  });

  it("does NOT split on semicolons inside dollar-quoted strings", () => {
    expect(guardQuery("SELECT $tag$a;b;c$tag$").ok).toBe(true);
  });
});

describe("guardQuery — keyword scanning ignores string-literal contents", () => {
  it("allows a string literal containing every forbidden verb", () => {
    expect(guardQuery("SELECT 'INSERT UPDATE DELETE DROP TRUNCATE' AS demo").ok).toBe(true);
  });

  it("allows escaped single quotes in a string literal", () => {
    expect(guardQuery("SELECT 'it''s fine' AS msg").ok).toBe(true);
  });

  it("does NOT ignore double-quoted IDENTIFIER contents (those are identifiers, not strings)", () => {
    // "DROP" used as an identifier inside a SELECT shouldn't slip through —
    // it's an unusual but possible construction and still indicates someone
    // doing something fishy.
    const r = guardQuery('SELECT * FROM "DROP"');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/DROP/);
  });

  it("rejects pg_sleep even when the surrounding query is otherwise innocuous", () => {
    expect(guardQuery("SELECT 1, pg_sleep(60)").ok).toBe(false);
  });

  it("allows a string literal that LOOKS like dollar-quoted but is actually inside single quotes", () => {
    expect(guardQuery("SELECT 'INSERT INTO foo' || $$bar$$ AS msg").ok).toBe(true);
  });
});
