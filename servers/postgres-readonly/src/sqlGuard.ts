// Server-side SELECT-only guard.
//
// Layered defense (D-004): the database role is ALSO read-only at the role level.
// This guard exists because (a) some operators forget the role step, and (b) even
// with a read-only role the server should refuse to *attempt* a write — silent
// failures at the DB layer leak less information than a clean rejection here.
//
// The guard is intentionally strict and conservative. If a query is ambiguous, it
// is rejected. False negatives (refusing a query a security analyst would call
// safe) are acceptable; false positives (allowing a query a security analyst
// would call unsafe) are not.

const ALLOWED_LEADING_KEYWORDS = new Set(["SELECT", "WITH", "VALUES", "TABLE", "EXPLAIN"]);

// EXPLAIN is allowed because it never executes the inner statement under default
// (non-ANALYZE) flags. EXPLAIN ANALYZE *would* execute writes and is rejected
// below by the "no ANALYZE on writes" check at the keyword scan.
//
// Statements like SHOW, RESET, BEGIN, COMMIT, etc. are deliberately not allowed.
// The MCP server is a per-call stateless surface; transactions and session
// settings have no business in this contract.

const FORBIDDEN_KEYWORDS_ANYWHERE = [
  // Write/DDL
  "INSERT", "UPDATE", "DELETE", "MERGE", "COPY",
  "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME",
  // `SELECT ... INTO newtbl` is equivalent to `CREATE TABLE newtbl AS SELECT`
  // (a DDL write) but never emits the CREATE token, so it must be caught here.
  // Safe: literals are stripped before the scan, `INSERT INTO` is already
  // blocked via INSERT, and no read-only top-level query uses a bare INTO (#74).
  "INTO",
  "GRANT", "REVOKE",
  // Locking and admin
  "LOCK", "REINDEX", "VACUUM", "CLUSTER", "ANALYZE",
  // Function-call escape hatches we never want a read-only client invoking.
  // `pg_signal_backend(pid, sig)` is the generic PARENT of the two children
  // below — it delivers SIGTERM/SIGINT to another backend, so blocking the
  // children (`pg_terminate_backend`/`pg_cancel_backend`) but not the parent was
  // itself a sibling gap (#106). `pg_promote` promotes a standby to primary and
  // `pg_wal_replay_pause`/`pg_wal_replay_resume` halt/resume WAL replay on a
  // standby — cluster/replication STATE changes in the same "exempt from
  // default_transaction_read_only, db.ts backstop can't gate it" class as the
  // WAL entries (`pg_switch_wal`) below (#106).
  "PG_TERMINATE_BACKEND", "PG_CANCEL_BACKEND", "PG_SIGNAL_BACKEND",
  "PG_PROMOTE", "PG_WAL_REPLAY_PAUSE", "PG_WAL_REPLAY_RESUME",
  "PG_RELOAD_CONF", "PG_SLEEP", "PG_NOTIFY",
  // Sequence functions. Postgres EXEMPTS nextval/setval/currval from
  // `default_transaction_read_only`, so the db.ts session backstop does NOT
  // catch them — the guard is the only defense. `setval` persistently rewrites
  // a live sequence and `nextval` burns values; both are "modification" under
  // the README threat model even on a role that only has sequence USAGE (#94).
  "NEXTVAL", "SETVAL", "CURRVAL",
  // XID-assigning transaction functions. `txid_current()` and its Postgres-13+
  // alias `pg_current_xact_id()` force the current transaction to be assigned a
  // real, permanent XID — advancing the cluster-global counter and writing a
  // pg_xact/WAL record, contributing to XID-wraparound pressure. Like
  // nextval/setval this side effect is EXEMPT from `default_transaction_read_only`,
  // so the db.ts backstop can't gate it — the guard is the sole defense (#112).
  // Whole-word matching (`_` is a word char) blocks these but leaves the read-only
  // siblings that DON'T assign an XID allowed: `txid_current_if_assigned`,
  // `pg_current_xact_id_if_assigned`, `txid_status`, `txid_current_snapshot` —
  // the same consuming-vs-peeking split as pg_logical_slot_get_* vs _peek_.
  "TXID_CURRENT", "PG_CURRENT_XACT_ID",
  // Server-side FILE I/O. These read (or, for lo_export, write) files on the
  // database host — filesystem, not the transaction — so read-only txns don't
  // gate them. Arbitrary server-file reads are data exfiltration beyond the
  // schema surface (#94). The `lo_*`/dblink/advisory FAMILIES live in
  // FORBIDDEN_FUNCTION_PREFIXES below since whole-word matching misses variants.
  "PG_READ_FILE", "PG_READ_BINARY_FILE", "PG_STAT_FILE",
  // Large-object fast-path functions spelled WITHOUT the `lo_` underscore.
  // The rest of the large-object API (`lo_put`/`lo_import`/`lo_export`/`lo_get`/
  // `lo_open`/`lo_from_bytea`/...) is caught by the `LO_` PREFIX in
  // FORBIDDEN_FUNCTION_PREFIXES, but the two historical names `lowrite(fd, data)`
  // and `loread(fd, len)` have no underscore after `lo`, so that prefix misses
  // them. `lowrite` WRITES bytes into a large object (a mutation of
  // pg_largeobject) and `loread` reads large-object bytes (exfiltration) — both
  // exempt from `default_transaction_read_only`, so the guard is the sole
  // defense, exactly like the underscore-spelled siblings. They are the ONLY two
  // large-object functions without the underscore, so whole-word entries close
  // the gap with no read-only variant over-blocked (#114).
  "LOWRITE", "LOREAD",
  // More admin/side-effecting functions in the same "exempt from
  // default_transaction_read_only" class as the entries above — the db.ts
  // session backstop does NOT gate them, so the guard is the sole defense (the
  // sibling gap #94 left open). `set_config(name, value, is_local)` is the
  // function-form twin of the `SET`/`RESET` keywords below — whole-word `SET`
  // can't match `SET_CONFIG` (`_` is a word char) — and can flip the very
  // `default_transaction_read_only` GUC the layered defense relies on.
  // `pg_switch_wal` forces a WAL segment switch; `pg_logical_emit_message`
  // writes a WAL record. `pg_stat_statements_reset` clears the statement-stats
  // extension (the core `pg_stat_reset*` family is a PREFIX below, but this
  // name doesn't share that prefix). The DROP/CREATE/replication-origin
  // families also live in FORBIDDEN_FUNCTION_PREFIXES below.
  "SET_CONFIG",
  "PG_SWITCH_WAL", "PG_LOGICAL_EMIT_MESSAGE", "PG_STAT_STATEMENTS_RESET",
  // Session changes
  "SET", "RESET",
  // Meta / out-of-band
  "DO", "CALL", "PREPARE", "EXECUTE", "DEALLOCATE", "DISCARD",
  "LISTEN", "UNLISTEN",
  "FOR UPDATE", "FOR SHARE", "FOR NO KEY UPDATE", "FOR KEY SHARE",
];

// Function FAMILIES a read-only client has no business invoking, where a plain
// whole-word entry would miss the variants (the pre-#94 `DBLINK` entry blocked
// `dblink(...)` but not `dblink_connect`/`dblink_send_query`, which are distinct
// tokens). Matched as a name PREFIX at a word boundary so every member is caught.
// Like the sequence/file functions above, these bypass BOTH the keyword list and
// the `default_transaction_read_only` backstop:
//   DBLINK*          — runs on a SEPARATE libpq connection the session setting
//                      never reaches, so a remote INSERT/DELETE runs for real.
//   LO_*             — large-object API; lo_export writes a server file, lo_import
//                      reads one, others read/write large-object data.
//   PG_ADVISORY* /   — advisory locks are session-scoped side effects (note
//   PG_TRY_ADVISORY*   pg_try_advisory_lock does NOT start with PG_ADVISORY).
//   PG_FILE_*        — adminpack server-file MUTATION family:
//                      pg_file_write/pg_file_unlink/pg_file_rename/pg_file_sync
//                      write/delete/rename/fsync files on the database host. The
//                      write twin of the already-blocked pg_read_file/lo_export
//                      file I/O — #94 closed the read + large-object-write
//                      direction but left this adminpack write family open (#106).
//                      No read-only pg_file_* exists (even pg_file_read is
//                      server-file exfiltration), so the prefix is safe.
//   PG_LS_*          — pg_ls_dir/pg_ls_waldir/pg_ls_logdir/... list server dirs.
//   PG_DROP_*        — pg_drop_replication_slot destroys a replication slot
//                      (breaks CDC/standbys); every pg_drop_* is destructive.
//   PG_CREATE_*      — pg_create_restore_point (writes WAL) and
//                      pg_create_{logical,physical}_replication_slot; no
//                      read-only pg_create_* exists.
//   PG_STAT_RESET*   — pg_stat_reset / _shared / _single_table_counters / _slru
//                      wipe server monitoring state. The read-only stat readers
//                      are pg_stat_get_* / pg_stat_file (already listed) and
//                      views, none of which start with PG_STAT_RESET.
//   PG_REPLICATION_ORIGIN* — replication-origin create/drop/advance/session
//                      side effects; the read-only status reader is
//                      pg_show_replication_origin_status (different prefix).
//   PG_REPLICATION_SLOT_ADVANCE — advances a replication slot, discarding WAL a
//                      standby/consumer still needs (breaks CDC/replication). The
//                      advance verb of the same slot lifecycle whose create
//                      (PG_CREATE_) and drop (PG_DROP_) are already blocked; the
//                      read-only slot reader is the pg_replication_slots *view*
//                      (trailing S, no _ADVANCE), which this exact prefix leaves
//                      allowed.
//   PG_LOGICAL_SLOT_GET_ — pg_logical_slot_get_changes / _get_binary_changes are
//                      the *consuming* decode variants: they advance the slot's
//                      confirmed position (destructive), unlike the read-only
//                      pg_logical_slot_PEEK_changes twins. The GET_ prefix blocks
//                      both consumers and deliberately does NOT catch _PEEK_.
//                      Advance/consume are the write verbs of the replication-slot
//                      lifecycle the #106 create/drop/origin pass left open.
//   PG_IMPORT_*      — pg_import_system_collations writes rows into the
//                      pg_collation catalog (a catalog mutation); no read-only
//                      pg_import_* exists.
//   BRIN_SUMMARIZE* /   — brin_summarize_new_values / brin_summarize_range /
//   BRIN_DESUMMARIZE*     brin_desummarize_range mutate BRIN index storage. The
//                      read-only brin inspectors are pageinspect's
//                      brin_page_items / brin_metapage_info / brin_revmap_data
//                      (distinct prefixes), so these two exact prefixes leave the
//                      reads allowed.
//   GIN_CLEAN_PENDING_LIST — flushes the GIN pending list into the main index (an
//                      index write); the read-only gin inspectors are pageinspect's
//                      gin_metapage_info / gin_page_opaque_info / gin_leafpage_items
//                      (distinct prefix).
//   PG_PREWARM*      — forces table/index pages into the buffer cache: a
//                      resource-consuming side effect in the same class as the
//                      already-blocked PG_SLEEP, and the guard is the sole defense.
// All of these are exempt from default_transaction_read_only, so like the
// families above the guard is their sole defense (#94 sibling gap). The guard's
// stated stance (sqlGuard.ts header) accepts over-blocking a query a security
// analyst would call safe; only UNDER-blocking is unacceptable — so prefix
// breadth is deliberate and aligned.
const FORBIDDEN_FUNCTION_PREFIXES = [
  "DBLINK",
  "LO_",
  "PG_FILE_",
  "PG_ADVISORY",
  "PG_TRY_ADVISORY",
  "PG_LS_",
  "PG_DROP_",
  "PG_CREATE_",
  "PG_STAT_RESET",
  "PG_REPLICATION_ORIGIN",
  "PG_REPLICATION_SLOT_ADVANCE",
  "PG_LOGICAL_SLOT_GET_",
  "PG_IMPORT_",
  "BRIN_SUMMARIZE",
  "BRIN_DESUMMARIZE",
  "GIN_CLEAN_PENDING_LIST",
  "PG_PREWARM",
];

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Strip SQL comments. Both line (`--`) and block (`/* ... *\/`) styles. We do
 * this BEFORE keyword detection so an attacker can't hide writes inside comments
 * (which would be safe at execution time but dangerous if the guard relied on
 * keyword-after-comment heuristics).
 *
 * Comment markers are recognised ONLY outside string literals (#54). A `--` or
 * `/* *\/` that appears *inside* a single-quoted string, a double-quoted
 * identifier, or a dollar-quoted string is literal data, not a comment — so the
 * literal is copied through verbatim (delimiters included). Without this, a `--`
 * inside a string truncated the input to end-of-line/EOF and could delete a real
 * forbidden call that followed the closing quote, e.g.
 * `SELECT 'a -- b', pg_sleep(1)` — valid SQL Postgres runs — was reduced to
 * `SELECT 'a ` before the keyword scan and wrongly passed the guard.
 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];

    // Dollar-quoted string ($tag$ ... $tag$ or $$ ... $$): copy verbatim so its
    // contents can't be mistaken for comment markers.
    if (c === "$") {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          // Unterminated dollar literal: copy the remainder verbatim and stop.
          // What to DO about an unterminated literal is the keyword scan's call
          // (guardQuery, see #55); stripComments must not silently eat it here.
          out += sql.slice(i);
          break;
        }
        out += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }

    // Single-quoted string literal ('...' with '' escape): copy verbatim.
    if (c === "'") {
      out += c;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''"; // doubled-quote escape stays inside the string
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Double-quoted identifier ("..." with "" escape): not a string, but comment
    // markers inside a quoted identifier are still literal — copy verbatim.
    if (c === '"') {
      out += c;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          out += '""';
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Line comment (outside any string literal). Emit a single space, NOT the
    // empty string: a SQL comment is a token separator, so eliding it can merge
    // the tokens on either side into one word and hide a forbidden keyword from
    // the whole-word scan (e.g. `INSERT/**/INTO` -> `INSERTINTO`, which
    // `(^|\W)INSERT(\W|$)` no longer matches). A space matches Postgres
    // tokenization exactly — a comment can separate tokens but never split one
    // (#74).
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // Block comment (note: we don't support nested blocks because Postgres does
    // and we're erring on the side of strictness — if the comment looks weird
    // the consumer would have rejected it anyway). Same space-not-empty rule as
    // the line comment above (#74).
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** Walk the string and split on `;` boundaries, but ignore semicolons inside string literals. */
function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let inDollar = false;
  let dollarTag = "";
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];

    if (inDollar) {
      // Walk until we hit the matching $tag$.
      if (c === "$" && sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        inDollar = false;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    if (!inSingle && !inDouble && c === "$") {
      // Detect a dollar-quoted string opening like $foo$ or $$.
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        const tag = m[0];
        buf += tag;
        i += tag.length;
        dollarTag = tag;
        inDollar = true;
        continue;
      }
    }

    // Postgres escapes a quote inside a string literal by DOUBLING it (''),
    // not with a backslash — backslash is a literal character under
    // standard_conforming_strings (the default since 9.1). The pre-fix
    // `sql[i-1] !== "\\"` check treated a backslash-then-quote as an escaped
    // (non-closing) quote, so a string ending in a backslash (`'a\'`) kept
    // `inSingle` set, a following `;` was mistaken for string content, and a
    // genuine multi-statement input parsed as one — silently bypassing the
    // multi-statement guard (#76). This mirrors the quote-doubling logic that
    // `stripComments` and `stripStringLiterals` already use; `splitStatements`
    // was the lone inconsistent scanner.
    if (!inDouble && c === "'") {
      if (inSingle && sql[i + 1] === "'") {
        // Doubled-quote escape inside the string — consume both, stay inside.
        buf += "''";
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      buf += c;
      i++;
      continue;
    }

    if (!inSingle && c === '"') {
      if (inDouble && sql[i + 1] === '"') {
        // Doubled double-quote inside a quoted identifier — consume both.
        buf += '""';
        i += 2;
        continue;
      }
      inDouble = !inDouble;
      buf += c;
      i++;
      continue;
    }

    if (!inSingle && !inDouble && c === ";") {
      parts.push(buf);
      buf = "";
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  if (buf.trim().length > 0) parts.push(buf);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Replace single-quoted, double-quoted, and dollar-quoted string literals with
 * neutral placeholders. Used before scanning for forbidden keywords so
 * `SELECT 'INSERT INTO foo'` doesn't false-positive on the `INSERT` substring.
 *
 * The string-content is replaced with a single space (never the empty string)
 * so adjacent identifiers don't merge into a forbidden keyword by accident
 * (e.g., `'pg_'||'sleep'` musn't become `pg_sleep` after stripping).
 *
 * Returns `unterminated: true` when an opener (dollar-quoted, single-quoted, or
 * double-quoted) has no matching closer (#55). Such input is malformed SQL that
 * Postgres rejects anyway, but more importantly the swallow-to-EOF that closing
 * an open literal requires would hide any forbidden keyword appearing AFTER the
 * opener (e.g. `SELECT 1, $x$DROP TABLE users` — the `$x$...` runs to EOF and
 * the keyword scan never sees DROP). `guardQuery` fails closed on this flag.
 */
function stripStringLiterals(sql: string): { text: string; unterminated: boolean } {
  let out = "";
  let unterminated = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];

    // Dollar-quoted string: $tag$...$tag$ or $$...$$
    if (c === "$") {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        const tag = m[0];
        const start = i + tag.length;
        const end = sql.indexOf(tag, start);
        if (end === -1) {
          // Unterminated dollar literal — fail closed (#55). Swallowing the rest
          // would hide any forbidden keyword after the opener.
          unterminated = true;
          out += " ";
          i = sql.length;
          continue;
        }
        out += " ";
        i = end + tag.length;
        continue;
      }
    }

    if (c === "'") {
      out += " ";
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          // Escaped single quote inside the string.
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      // Unterminated single-quoted literal — fail closed (#55).
      if (!closed) unterminated = true;
      continue;
    }

    if (c === '"') {
      // Double-quoted identifier (NOT a string in Postgres). Keep contents
      // visible so an attacker can't smuggle a forbidden keyword as a quoted
      // identifier — `"DROP" TABLE x` should still trip the DROP scan.
      out += '"';
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          out += '""';
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === '"') {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      // Unterminated quoted identifier — fail closed (#55). Contents stay visible
      // here so this is belt-and-suspenders, but malformed SQL is rejected
      // consistently with the guard's "ambiguous → reject" stance.
      if (!closed) unterminated = true;
      continue;
    }

    out += c;
    i++;
  }
  return { text: out, unterminated };
}

/** True iff `text` contains `kw` as a whole word (case-insensitive). */
function containsKeyword(text: string, kw: string): boolean {
  const re = new RegExp(`(^|\\W)${kw.replace(/ /g, "\\s+")}(\\W|$)`, "i");
  return re.test(text);
}

/**
 * True iff `text` contains a token that STARTS with `prefix` at a word boundary
 * (case-insensitive) — e.g. prefix `DBLINK` matches `dblink_connect`. Used for
 * forbidden function families (#94). Prefixes are `[A-Za-z_]`-only, so no regex
 * metacharacters need escaping.
 */
function containsFunctionPrefix(text: string, prefix: string): boolean {
  const re = new RegExp(`(^|\\W)${prefix}[A-Za-z0-9_]*`, "i");
  return re.test(text);
}

export function guardQuery(sqlInput: string): GuardResult {
  if (typeof sqlInput !== "string" || sqlInput.trim().length === 0) {
    return { ok: false, reason: "empty query" };
  }

  const stripped = stripComments(sqlInput);
  const statements = splitStatements(stripped);

  if (statements.length === 0) {
    return { ok: false, reason: "no executable statement after stripping comments" };
  }

  if (statements.length > 1) {
    return {
      ok: false,
      reason: `multi-statement input rejected (got ${statements.length} statements)`,
    };
  }

  const stmt = statements[0];

  const leading = (stmt.match(/^\s*([A-Za-z]+)/) || [])[1]?.toUpperCase();
  if (!leading || !ALLOWED_LEADING_KEYWORDS.has(leading)) {
    return {
      ok: false,
      reason: `leading keyword ${leading ?? "<none>"} not in allowed set { ${[...ALLOWED_LEADING_KEYWORDS].join(", ")} }`,
    };
  }

  // Strip string literals before keyword scanning so a SELECT containing the
  // literal 'INSERT INTO foo' doesn't false-positive. Double-quoted identifiers
  // are NOT stripped (they're identifiers, not string contents in Postgres).
  const { text: scanText, unterminated } = stripStringLiterals(stmt);

  // Fail closed on a malformed (unterminated) literal (#55). Otherwise the
  // swallow-to-EOF needed to consume the open literal would hide any forbidden
  // keyword that follows the opener, e.g. `SELECT 1, $x$DROP TABLE users`.
  if (unterminated) {
    return { ok: false, reason: "unterminated string literal" };
  }

  for (const kw of FORBIDDEN_KEYWORDS_ANYWHERE) {
    if (containsKeyword(scanText, kw)) {
      return { ok: false, reason: `forbidden keyword present: ${kw}` };
    }
  }

  for (const pfx of FORBIDDEN_FUNCTION_PREFIXES) {
    if (containsFunctionPrefix(scanText, pfx)) {
      return { ok: false, reason: `forbidden function family: ${pfx}*` };
    }
  }

  return { ok: true };
}
