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

  it("rejects a multi-statement input whose first string ends in a backslash (#76)", () => {
    // Postgres escapes quotes by doubling ('') — a backslash is a literal under
    // standard_conforming_strings. Pre-#76, splitStatements treated the closing
    // quote of `'a\'` (one backslash) as escaped, kept the string "open", and
    // swallowed the `;`, so this genuine two-statement input passed as one.
    // SQL seen by the guard: SELECT 'a\'; SELECT 1;
    const r = guardQuery("SELECT 'a\\'; SELECT 1;");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multi-statement/);
  });

  it("rejects the same bypass with two trailing backslashes (#76)", () => {
    // SQL seen by the guard: SELECT 'a\\'; SELECT 1;  (value is a + two backslashes)
    const r = guardQuery("SELECT 'a\\\\'; SELECT 1;");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multi-statement/);
  });

  it("still catches a WRITE smuggled after the backslash trick (#76, defense-in-depth)", () => {
    // Even before #76 the keyword scan caught this (stripStringLiterals closes
    // the string correctly), but lock it so the two layers stay in agreement.
    // SQL: SELECT 'a\'; DROP TABLE users;
    const r = guardQuery("SELECT 'a\\'; DROP TABLE users;");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/DROP|multi-statement/);
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

describe("guardQuery — SELECT INTO and comment-merged keyword bypasses (#74)", () => {
  it("rejects SELECT ... INTO newtbl (equivalent to CREATE TABLE AS)", () => {
    // `SELECT ... INTO t` creates a table — a DDL write — but the leading
    // keyword is SELECT (allowed) and it never emits the CREATE token, so it
    // was passing the guard before INTO joined the forbidden list.
    const r = guardQuery("SELECT * INTO newtbl FROM users");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/INTO/);
  });

  it("rejects SELECT id INTO TEMP t (temp-table write form too)", () => {
    expect(guardQuery("SELECT id INTO TEMP t FROM users").ok).toBe(false);
  });

  it("rejects an INSERT-writing CTE smuggled with a block comment between INSERT and INTO", () => {
    // `INSERT/**/INTO` is valid SQL (== `INSERT INTO`). Before #74, stripComments
    // elided the comment to the empty string, merging the tokens into
    // `INSERTINTO`, which the whole-word INSERT scan no longer matched.
    const r = guardQuery("WITH x AS (INSERT/**/INTO t VALUES (1) RETURNING 1) SELECT * FROM x");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/INSERT/);
  });

  it("rejects a DELETE-writing CTE smuggled with a block comment", () => {
    const r = guardQuery("WITH x AS (DELETE/**/FROM t WHERE id = 1 RETURNING 1) SELECT * FROM x");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/DELETE/);
  });

  it("rejects a FOR UPDATE row lock split by a block comment (FOR/**/UPDATE)", () => {
    expect(guardQuery("SELECT * FROM users FOR/**/UPDATE").ok).toBe(false);
  });

  it("still allows a block comment that legitimately separates two real tokens", () => {
    // The fix replaces a comment with a single space, not the empty string, so a
    // comment used as a token separator (`a/**/b` == `a b` == `a AS b`) must
    // remain a valid read — the fix must not over-reject legitimate SQL.
    expect(guardQuery("SELECT a/**/b FROM t").ok).toBe(true);
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

  it("does NOT falsely reject a single statement whose string value ends in a backslash (#76)", () => {
    // The #76 fix must not over-correct: `'path\'` is one valid statement whose
    // value ends in a backslash; the trailing quote genuinely closes the string.
    // SQL: SELECT 'path\' AS p
    expect(guardQuery("SELECT 'path\\' AS p").ok).toBe(true);
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

describe("guardQuery — comment markers inside string literals (#54)", () => {
  // stripComments must treat `--` and `/* */` INSIDE a string literal as literal
  // data, not as comment starts. The dangerous case is a comment marker inside a
  // string whose closing quote is followed by a real forbidden call: stripping
  // the "comment" to EOL/EOF deletes the call before the keyword scan ever sees
  // it, so the guard wrongly passes a query Postgres would actually execute.

  it("rejects a forbidden call hidden after a `--` inside a single-quoted string (was a bypass)", () => {
    // `SELECT 'a -- b', pg_sleep(1)` is valid SQL: 'a -- b' is a string literal,
    // then `, pg_sleep(1)`. The `--` is data, not a comment. Pre-fix, stripComments
    // ate `-- b', pg_sleep(1)` and the guard returned ok:true while the query runs
    // pg_sleep.
    const r = guardQuery("SELECT 'a -- b', pg_sleep(1)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PG_SLEEP/);
  });

  it("rejects a forbidden call hidden after a `/* */` opener inside a single-quoted string", () => {
    const r = guardQuery("SELECT 'x /* y', pg_terminate_backend(1)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PG_TERMINATE_BACKEND/);
  });

  it("allows a legitimate query with `--` inside a string and nothing dangerous after", () => {
    expect(guardQuery("SELECT 'a -- b' AS note").ok).toBe(true);
  });

  it("allows a legitimate query with `/* */` inside a string", () => {
    expect(guardQuery("SELECT 'a /* not a comment */ b' AS note").ok).toBe(true);
  });

  it("treats `--` inside a string with NO trailing newline as data, not a comment", () => {
    // No newline after the in-string `--`: pre-fix the line-comment strip ran to
    // EOF and deleted the closing quote plus the forbidden call that followed.
    const r = guardQuery("SELECT 'note -- x', pg_terminate_backend(7)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PG_TERMINATE_BACKEND/);
  });

  it("treats `--` inside a dollar-quoted string as data, not a comment", () => {
    // The dollar literal carries a `--`; a real DROP follows the closing $tag$.
    const r = guardQuery("SELECT $t$a -- b$t$, pg_sleep(1)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PG_SLEEP/);
  });

  it("treats `--` inside a double-quoted identifier as data, not a comment", () => {
    // "weird -- name" is a quoted identifier; pg_sleep after it must still trip.
    const r = guardQuery('SELECT "weird -- name", pg_sleep(1) FROM t');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PG_SLEEP/);
  });

  it("still strips a genuine line comment that hides a second statement", () => {
    // Regression guard: the fix must not stop recognising real comments outside
    // strings. `-- safe\nDROP` splits into two statements after stripping.
    expect(guardQuery("SELECT 1 -- safe\n; DROP TABLE x").ok).toBe(false);
  });

  it("still allows a genuine block comment that really contains a forbidden keyword", () => {
    expect(guardQuery("SELECT 1 /* DROP TABLE x */").ok).toBe(true);
  });
});

describe("guardQuery — unterminated string literals fail closed (#55)", () => {
  // An unterminated literal forces stripStringLiterals to swallow the rest of the
  // input, which hid any forbidden keyword after the opener and let the guard
  // return ok:true on a query it should reject. The fix fails closed: an
  // unterminated literal is malformed SQL Postgres rejects anyway.

  it("rejects an unterminated $tag$ literal that hides INSERT (reproduced)", () => {
    const r = guardQuery("SELECT 1, $x$INSERT INTO users VALUES (1)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unterminated string literal/);
  });

  it("rejects an unterminated $tag$ literal that hides DROP (reproduced)", () => {
    const r = guardQuery("SELECT 1, $x$DROP TABLE users");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unterminated string literal/);
  });

  it("rejects an unterminated $$ literal that hides a forbidden keyword", () => {
    const r = guardQuery("SELECT 1, $$DELETE FROM users");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unterminated string literal/);
  });

  it("rejects an unterminated single-quoted literal that hides a forbidden keyword", () => {
    const r = guardQuery("SELECT 1, 'DROP TABLE users");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unterminated string literal/);
  });

  it("rejects an unterminated single-quoted literal whose tail is otherwise innocuous", () => {
    // Even with no forbidden keyword after it, an unterminated literal is
    // malformed and must fail closed rather than be silently swallowed.
    const r = guardQuery("SELECT 'oops");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unterminated string literal/);
  });

  it("rejects an unterminated double-quoted identifier", () => {
    const r = guardQuery('SELECT "oops');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unterminated string literal/);
  });

  it("rejects an odd-quote-count tail (open quote after an escaped pair)", () => {
    // `'a''b` => escaped quote then an unterminated opener.
    const r = guardQuery("SELECT 'a''b");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unterminated string literal/);
  });

  it("still allows properly-terminated literals (no false rejection)", () => {
    expect(guardQuery("SELECT 1, $x$ok$x$").ok).toBe(true);
    expect(guardQuery("SELECT 1, $$ok$$").ok).toBe(true);
    expect(guardQuery("SELECT 'ok'").ok).toBe(true);
    expect(guardQuery("SELECT 'it''s fine'").ok).toBe(true);
    expect(guardQuery('SELECT * FROM "tbl"').ok).toBe(true);
  });
});

describe("guardQuery — rejected (side-effecting functions the read-only backstop misses, #94)", () => {
  // Postgres EXEMPTS sequence functions from `default_transaction_read_only`,
  // so db.ts's session backstop never catches these — the guard is the only
  // defense. `setval` persistently rewrites a live sequence; `nextval` burns it.
  it("rejects setval (persistently rewrites a sequence)", () => {
    const r = guardQuery("SELECT setval('users_id_seq', 1, false)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/SETVAL/);
  });

  it("rejects nextval (advances/burns a sequence)", () => {
    expect(guardQuery("SELECT nextval('users_id_seq')").ok).toBe(false);
  });

  it("rejects currval", () => {
    expect(guardQuery("SELECT currval('users_id_seq')").ok).toBe(false);
  });

  it("rejects sequence functions case-insensitively", () => {
    expect(guardQuery("select SetVal('s', 100)").ok).toBe(false);
  });

  // Server-side file I/O: filesystem, not the transaction, so read-only txns
  // don't gate them. Arbitrary reads are exfiltration; lo_export writes a file.
  it("rejects pg_read_file (arbitrary server-file exfiltration)", () => {
    expect(guardQuery("SELECT pg_read_file('/etc/passwd', 0, 100)").ok).toBe(false);
  });

  it("rejects pg_read_binary_file", () => {
    expect(guardQuery("SELECT pg_read_binary_file('/etc/passwd')").ok).toBe(false);
  });

  it("rejects pg_stat_file", () => {
    expect(guardQuery("SELECT pg_stat_file('/etc/passwd')").ok).toBe(false);
  });

  it("rejects pg_ls_dir (server directory listing)", () => {
    expect(guardQuery("SELECT pg_ls_dir('/var/lib/postgresql/data')").ok).toBe(false);
  });

  it("rejects other pg_ls_* directory-listing variants", () => {
    expect(guardQuery("SELECT pg_ls_waldir()").ok).toBe(false);
    expect(guardQuery("SELECT pg_ls_logdir()").ok).toBe(false);
  });

  it("rejects lo_export (writes a file on the server host)", () => {
    expect(guardQuery("SELECT lo_export(1234, '/tmp/exfil')").ok).toBe(false);
  });

  it("rejects lo_import and other large-object functions", () => {
    expect(guardQuery("SELECT lo_import('/etc/passwd')").ok).toBe(false);
    expect(guardQuery("SELECT lo_put(1, 0, 'x')").ok).toBe(false);
  });

  // lowrite/loread are the two large-object functions spelled WITHOUT the `lo_`
  // underscore, so the `LO_` prefix that blocks lo_put/lo_import/lo_export misses
  // them; whole-word LOWRITE/LOREAD entries close the gap (#114). lowrite mutates
  // pg_largeobject (a write on a read-only server); loread exfiltrates LO bytes.
  it("rejects lowrite/loread (underscore-less large-object siblings of the LO_ family)", () => {
    expect(guardQuery("SELECT lowrite(0, 'abc')").ok).toBe(false);
    expect(guardQuery("SELECT loread(0, 100)").ok).toBe(false);
    // case-insensitive
    expect(guardQuery("SELECT LOWRITE(0,'a')").ok).toBe(false);
    expect(guardQuery("SELECT LoRead(0, 10)").ok).toBe(false);
    // hidden inside a CTE
    expect(guardQuery("WITH x AS (SELECT lowrite(0,'a')) SELECT * FROM x").ok).toBe(false);
    // whole-word matching: identifiers that merely START with the names (a longer
    // token) are not over-blocked, e.g. a column `loreadings` or author `lowriter`
    expect(guardQuery("SELECT loreadings, lowriter FROM catalog").ok).toBe(true);
  });

  // dblink_* runs on a SEPARATE libpq connection the session setting can't
  // reach; the pre-#94 whole-word `DBLINK` entry missed these variants.
  it("rejects dblink_connect (whole-word DBLINK entry missed this)", () => {
    expect(guardQuery("SELECT dblink_connect('host=evil user=x')").ok).toBe(false);
  });

  it("rejects dblink_send_query (remote write on a fresh connection)", () => {
    expect(guardQuery("SELECT dblink_send_query('c', 'DELETE FROM users')").ok).toBe(false);
  });

  it("rejects dblink_exec", () => {
    expect(guardQuery("SELECT dblink_exec('c', 'DELETE FROM users')").ok).toBe(false);
  });

  it("still rejects the original whole-word dblink(...) form", () => {
    expect(guardQuery("SELECT * FROM dblink('db', 'SELECT 1') AS t(x int)").ok).toBe(false);
  });

  // Advisory locks are session-scoped side effects. pg_try_advisory_lock does
  // NOT start with PG_ADVISORY — the PG_TRY_ADVISORY prefix covers it.
  it("rejects pg_advisory_lock", () => {
    expect(guardQuery("SELECT pg_advisory_lock(42)").ok).toBe(false);
  });

  it("rejects pg_advisory_xact_lock", () => {
    expect(guardQuery("SELECT pg_advisory_xact_lock(42)").ok).toBe(false);
  });

  it("rejects pg_try_advisory_lock (distinct prefix)", () => {
    expect(guardQuery("SELECT pg_try_advisory_lock(42)").ok).toBe(false);
  });

  it("rejects pg_try_advisory_xact_lock", () => {
    expect(guardQuery("SELECT pg_try_advisory_xact_lock(42)").ok).toBe(false);
  });

  // #104: more admin/side-effecting functions in the same "exempt from
  // default_transaction_read_only" class #94 partially covered. All reachable
  // via a single run_select statement; the guard is their sole defense.
  it("rejects set_config (function-form twin of SET; can flip read-only GUC)", () => {
    // whole-word SET can't match SET_CONFIG (`_` is a word char), so this needs
    // its own entry — it can set default_transaction_read_only = off.
    expect(guardQuery("SELECT set_config('default_transaction_read_only','off',false)").ok).toBe(
      false,
    );
  });

  it("rejects pg_switch_wal (forces a WAL segment switch)", () => {
    expect(guardQuery("SELECT pg_switch_wal()").ok).toBe(false);
  });

  it("rejects pg_logical_emit_message (writes a WAL record)", () => {
    expect(guardQuery("SELECT pg_logical_emit_message(true, 'a', 'b')").ok).toBe(false);
  });

  it("rejects pg_drop_replication_slot (PG_DROP_ family; destroys a slot)", () => {
    expect(guardQuery("SELECT pg_drop_replication_slot('slot1')").ok).toBe(false);
  });

  it("rejects pg_create_restore_point (PG_CREATE_ family; writes WAL)", () => {
    expect(guardQuery("SELECT pg_create_restore_point('rp')").ok).toBe(false);
  });

  it("rejects pg_create_logical_replication_slot (PG_CREATE_ family)", () => {
    expect(
      guardQuery("SELECT pg_create_logical_replication_slot('s','test_decoding')").ok,
    ).toBe(false);
  });

  it("rejects pg_create_physical_replication_slot (PG_CREATE_ family)", () => {
    expect(guardQuery("SELECT pg_create_physical_replication_slot('s')").ok).toBe(false);
  });

  it("rejects pg_stat_reset (PG_STAT_RESET family; wipes monitoring stats)", () => {
    expect(guardQuery("SELECT pg_stat_reset()").ok).toBe(false);
  });

  it("rejects pg_stat_reset_shared (PG_STAT_RESET family)", () => {
    expect(guardQuery("SELECT pg_stat_reset_shared('bgwriter')").ok).toBe(false);
  });

  it("rejects pg_stat_statements_reset (own whole-word entry; distinct prefix)", () => {
    expect(guardQuery("SELECT pg_stat_statements_reset()").ok).toBe(false);
  });

  it("rejects pg_replication_origin_create (PG_REPLICATION_ORIGIN family)", () => {
    expect(guardQuery("SELECT pg_replication_origin_create('o')").ok).toBe(false);
  });

  it("rejects pg_replication_origin_drop (PG_REPLICATION_ORIGIN family)", () => {
    expect(guardQuery("SELECT pg_replication_origin_drop('o')").ok).toBe(false);
  });

  // #108: the advance/consume verbs of the replication-slot lifecycle — the
  // #106 create/drop/origin pass left these open. Each mutates replication
  // state (advances a slot / discards WAL) and is exempt from
  // default_transaction_read_only, so the guard is the sole defense.
  it("rejects pg_replication_slot_advance (PG_REPLICATION_SLOT_ADVANCE; discards WAL)", () => {
    expect(guardQuery("SELECT pg_replication_slot_advance('s','0/16B1750')").ok).toBe(false);
  });

  it("rejects pg_logical_slot_get_changes (PG_LOGICAL_SLOT_GET_; consuming decode)", () => {
    expect(guardQuery("SELECT pg_logical_slot_get_changes('s', NULL, NULL)").ok).toBe(false);
  });

  it("rejects pg_logical_slot_get_binary_changes (PG_LOGICAL_SLOT_GET_ family)", () => {
    expect(guardQuery("SELECT pg_logical_slot_get_binary_changes('s', NULL, NULL)").ok).toBe(
      false,
    );
  });

  // #108 regression: the read-only slot readers must STILL pass — the new
  // prefixes over-block nothing a read-only client needs.
  it("still allows pg_logical_slot_peek_changes (read-only decode, not GET_)", () => {
    expect(guardQuery("SELECT pg_logical_slot_peek_changes('s', NULL, NULL)")).toEqual({
      ok: true,
    });
  });

  it("still allows the pg_replication_slots view (read, not _ADVANCE)", () => {
    expect(guardQuery("SELECT slot_name, active FROM pg_replication_slots")).toEqual({
      ok: true,
    });
  });

  // #110: state-mutating admin / index-maintenance functions the #94/#104/#106
  // passes left open — each mutates catalog or index storage (or, for
  // pg_prewarm, consumes I/O like the blocked pg_sleep) and is exempt from
  // default_transaction_read_only, so the guard is the sole defense.
  it("rejects pg_import_system_collations (PG_IMPORT_; writes pg_collation)", () => {
    expect(guardQuery("SELECT pg_import_system_collations('pg_catalog')").ok).toBe(false);
  });

  it("rejects brin_summarize_new_values (BRIN_SUMMARIZE; mutates BRIN index)", () => {
    expect(guardQuery("SELECT brin_summarize_new_values('idx')").ok).toBe(false);
  });

  it("rejects brin_summarize_range (BRIN_SUMMARIZE family)", () => {
    expect(guardQuery("SELECT brin_summarize_range('idx', 0)").ok).toBe(false);
  });

  it("rejects brin_desummarize_range (BRIN_DESUMMARIZE; mutates BRIN index)", () => {
    expect(guardQuery("SELECT brin_desummarize_range('idx', 0)").ok).toBe(false);
  });

  it("rejects gin_clean_pending_list (GIN_CLEAN_PENDING_LIST; index write)", () => {
    expect(guardQuery("SELECT gin_clean_pending_list('idx')").ok).toBe(false);
  });

  it("rejects pg_prewarm (PG_PREWARM; forces pages into the buffer cache)", () => {
    expect(guardQuery("SELECT pg_prewarm('tbl')").ok).toBe(false);
    expect(guardQuery("SELECT pg_prewarm('tbl', 'buffer')").ok).toBe(false);
  });

  // #110 regression: the read-only pageinspect siblings of the brin/gin
  // maintenance functions must STILL pass — the new prefixes over-block nothing.
  it("still allows brin_page_items / brin_metapage_info (pageinspect reads)", () => {
    expect(guardQuery("SELECT * FROM brin_page_items(get_raw_page('i', 0), 'i')")).toEqual({
      ok: true,
    });
    expect(guardQuery("SELECT brin_metapage_info(get_raw_page('i', 0))")).toEqual({ ok: true });
  });

  it("still allows gin_metapage_info / gin_leafpage_items (pageinspect reads)", () => {
    expect(guardQuery("SELECT gin_metapage_info(get_raw_page('i', 0))")).toEqual({ ok: true });
    expect(guardQuery("SELECT gin_leafpage_items(get_raw_page('i', 0))")).toEqual({ ok: true });
  });

  // #104 regression: the read-only siblings of the new families must STILL pass
  // — the new prefixes/keywords over-block nothing a read-only client needs.
  it("still allows pg_stat_get_numscans (PG_STAT_ read, not PG_STAT_RESET)", () => {
    expect(guardQuery("SELECT pg_stat_get_numscans('t'::regclass)")).toEqual({ ok: true });
  });

  it("still allows pg_current_wal_lsn (read, not pg_switch_wal)", () => {
    expect(guardQuery("SELECT pg_current_wal_lsn()")).toEqual({ ok: true });
  });

  it("still allows pg_show_replication_origin_status (read, distinct prefix)", () => {
    expect(guardQuery("SELECT pg_show_replication_origin_status()")).toEqual({ ok: true });
  });

  it("still allows current_setting (GUC read, not set_config)", () => {
    expect(guardQuery("SELECT current_setting('search_path')")).toEqual({ ok: true });
  });

  // Regression: legit reads whose identifiers coincidentally share letters with
  // a forbidden family must STILL pass. `low_stock` is not `lo_*` (the prefix is
  // `lo_`, and `low` breaks at the `w`); `setup_id`/`settings` are not SET/SETVAL.
  it("still allows a read with a low_stock column (not the lo_ family)", () => {
    expect(guardQuery("SELECT location, low_stock FROM inventory")).toEqual({ ok: true });
  });

  it("still allows a read with setup_id / settings columns (not SET/SETVAL)", () => {
    expect(guardQuery("SELECT setup_id, settings FROM configs")).toEqual({ ok: true });
  });

  it("still allows a benign pg_ function like pg_typeof", () => {
    expect(guardQuery("SELECT pg_typeof(id) FROM users")).toEqual({ ok: true });
  });

  it("still allows an ordinary aggregate read", () => {
    expect(guardQuery("SELECT count(*) FROM orders")).toEqual({ ok: true });
  });

  // #106: the adminpack server-file MUTATION family (PG_FILE_ prefix). #94
  // closed the file-READ direction (pg_read_file/pg_stat_file) and the
  // large-object file-WRITE (lo_export) but left the pg_file_* write/delete/
  // rename/sync twins open — filesystem I/O exempt from
  // default_transaction_read_only, so the guard is their sole defense.
  it("rejects pg_file_write (writes a file on the server host, PG_FILE_ family)", () => {
    const r = guardQuery("SELECT pg_file_write('data/x.txt', 'payload', false)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PG_FILE_/);
  });

  it("rejects pg_file_unlink (deletes a server file)", () => {
    expect(guardQuery("SELECT pg_file_unlink('data/x.txt')").ok).toBe(false);
  });

  it("rejects pg_file_rename (renames server files)", () => {
    expect(guardQuery("SELECT pg_file_rename('a.txt', 'b.txt')").ok).toBe(false);
  });

  it("rejects pg_file_sync (fsyncs a server file/dir)", () => {
    expect(guardQuery("SELECT pg_file_sync('data')").ok).toBe(false);
  });

  it("rejects the schema-qualified adminpack.pg_file_unlink form", () => {
    // The prefix matches at a `\W` word boundary, so the `adminpack.` schema
    // qualifier doesn't evade it.
    expect(guardQuery("SELECT adminpack.pg_file_unlink('data/x.txt')").ok).toBe(false);
  });

  // pg_signal_backend is the generic PARENT of the already-blocked
  // pg_terminate_backend / pg_cancel_backend children — blocking the children
  // but not the parent was itself a sibling gap (#106).
  it("rejects pg_signal_backend (parent of terminate/cancel_backend)", () => {
    const r = guardQuery("SELECT pg_signal_backend(123, 15)");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PG_SIGNAL_BACKEND/);
  });

  it("rejects pg_promote (promotes a standby to primary; cluster state change)", () => {
    expect(guardQuery("SELECT pg_promote()").ok).toBe(false);
  });

  it("rejects pg_wal_replay_pause / pg_wal_replay_resume (halt/resume WAL replay)", () => {
    expect(guardQuery("SELECT pg_wal_replay_pause()").ok).toBe(false);
    expect(guardQuery("SELECT pg_wal_replay_resume()").ok).toBe(false);
  });

  // #106 regression: read-only pg_ functions that share leading letters with the
  // new PG_FILE_ prefix / new keywords must STILL pass — over-block nothing.
  it("still allows pg_filenode_relation (read; not the pg_file_ mutation family)", () => {
    // `pg_filenode_relation` starts `pg_file` but the prefix is `PG_FILE_`
    // (with the trailing underscore), and `pg_filenode` breaks at `n`.
    expect(guardQuery("SELECT pg_filenode_relation(1663, 12345)")).toEqual({ ok: true });
  });

  // #112: the XID-assigning transaction functions. txid_current() and its
  // Postgres-13+ alias pg_current_xact_id() force assignment of a real,
  // permanent XID — advancing the cluster-global counter + writing a pg_xact/WAL
  // record (wraparound pressure). Exempt from default_transaction_read_only like
  // nextval/setval, so the db.ts backstop can't gate them; the guard is the sole
  // defense. Sixth sibling in the #94/#106/#108/#110/#111 denylist-completeness
  // lineage. The read-only *_if_assigned / *_snapshot / txid_status peekers must
  // stay allowed (consuming-vs-peeking split, cf. pg_logical_slot_get_ vs _peek_).
  it("rejects txid_current (assigns a permanent XID)", () => {
    const r = guardQuery("SELECT txid_current()");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TXID_CURRENT/);
  });

  it("rejects pg_current_xact_id (PG13+ alias of txid_current)", () => {
    const r = guardQuery("SELECT pg_current_xact_id()");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PG_CURRENT_XACT_ID/);
  });

  it("rejects txid_current inside a CTE", () => {
    expect(guardQuery("WITH t AS (SELECT txid_current()) SELECT * FROM t").ok).toBe(false);
  });

  it("rejects txid_current case-insensitively", () => {
    expect(guardQuery("select TxId_Current()").ok).toBe(false);
  });

  it("still allows txid_current_if_assigned (peeks; assigns no XID)", () => {
    expect(guardQuery("SELECT txid_current_if_assigned()")).toEqual({ ok: true });
  });

  it("still allows pg_current_xact_id_if_assigned (peeks; assigns no XID)", () => {
    expect(guardQuery("SELECT pg_current_xact_id_if_assigned()")).toEqual({ ok: true });
  });

  it("still allows txid_status (reports a given xid's status; read-only)", () => {
    expect(guardQuery("SELECT txid_status(100)")).toEqual({ ok: true });
  });

  it("still allows txid_current_snapshot (returns the current snapshot; read-only)", () => {
    expect(guardQuery("SELECT txid_current_snapshot()")).toEqual({ ok: true });
  });
});
