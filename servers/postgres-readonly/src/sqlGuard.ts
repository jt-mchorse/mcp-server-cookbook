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
  "GRANT", "REVOKE",
  // Locking and admin
  "LOCK", "REINDEX", "VACUUM", "CLUSTER", "ANALYZE",
  // Function-call escape hatches we never want a read-only client invoking
  "PG_TERMINATE_BACKEND", "PG_CANCEL_BACKEND",
  "PG_RELOAD_CONF", "PG_SLEEP", "PG_NOTIFY",
  "DBLINK", "DBLINK_EXEC",
  // Session changes
  "SET", "RESET",
  // Meta / out-of-band
  "DO", "CALL", "PREPARE", "EXECUTE", "DEALLOCATE", "DISCARD",
  "LISTEN", "UNLISTEN",
  "FOR UPDATE", "FOR SHARE", "FOR NO KEY UPDATE", "FOR KEY SHARE",
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

    // Line comment (outside any string literal).
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    // Block comment (note: we don't support nested blocks because Postgres does
    // and we're erring on the side of strictness — if the comment looks weird
    // the consumer would have rejected it anyway).
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
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

    if (!inDouble && c === "'" && sql[i - 1] !== "\\") {
      inSingle = !inSingle;
      buf += c;
      i++;
      continue;
    }

    if (!inSingle && c === '"' && sql[i - 1] !== "\\") {
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

  return { ok: true };
}
