/**
 * Every VOLATILE pg_catalog function is either refused or allowed for a stated
 * reason (#258).
 *
 * The guard's lists were written from memory, and a sweep of `pg_proc` found
 * siblings of entries already on them. Measured on Postgres 17.6 in a READ ONLY
 * transaction, each passing `guardQuery` on main:
 *
 *   pg_sleep_for('1 second')   slept 1.002 s           (PG_SLEEP is whole-word)
 *   pg_log_standby_snapshot()  insert LSN 0/1A09AF0 -> 0/1A09B28 (wrote WAL)
 *   pg_nextoid(...)            OID counter 16445 -> 16446
 *   pg_hba_file_rules()        local {all} {all} trust, ...
 *   pg_show_all_file_settings() /tmp/pg17_240/postgresql.conf | max_connections | 100
 *   pg_current_logfile()       the server log path
 *
 * The population is `test/fixtures/pg17-volatile-functions.txt`, generated from
 * pg_proc (the command is in its header). A function a new list entry would
 * newly allow, or a new major version's volatile function, has to land in a
 * category below with its reason, or this fails.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { guardQuery } from "../src/sqlGuard.js";

const VOLATILE = readFileSync(new URL("./fixtures/pg17-volatile-functions.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0 && !line.startsWith("#"));

// [category, matcher]. Each reason was checked against Postgres 17.6.
const ALLOWED: Array<[string, RegExp]> = [
  ["errors unless the server is in binary-upgrade mode", /^binary_upgrade_/],
  [
    "trigger functions: error unless the trigger manager calls them",
    /^RI_FKey_|_trigger(_column)?$|^unique_key_recheck$/,
  ],
  [
    "access-method, language and tablesample handlers and validators (internal arguments)",
    /handler$|^plpgsql_|^dsnowball_|^amvalidate$|^system$|^bernoulli$/,
  ],
  [
    "statistics readers, and this backend's own stats snapshot",
    /^pg_stat_get_|^pg_stat_have_stats$|^pg_stat_clear_snapshot$|^pg_stat_force_next_flush$/,
  ],
  [
    "read-only server-state readers (peek_ is the non-consuming twin the GET_ prefix leaves allowed)",
    new RegExp(
      [
        "^pg_control_",
        "^pg_current_wal_",
        "^pg_last_",
        "^pg_is_",
        "^pg_get_",
        "_size$",
        "^pg_partition_",
        "^pg_lock_status$",
        "blocking_pids$",
        "^pg_isolation_test_session_is_blocked$",
        "^pg_prepared_xact$",
        "^pg_xact_",
        "^txid_status$",
        "^pg_sequence_last_value$",
        "collation_actual_version$",
        "^pg_jit_available$",
        "^pg_notification_queue_usage$",
        "^pg_available_wal_summaries$",
        "^pg_wal_summary_contents$",
        "^pg_show_replication_origin_status$",
        "^pg_logical_slot_peek_",
      ].join("|"),
    ),
  ],
  [
    "volatile only because the answer changes; no effect outside the session",
    /^(clock_timestamp|timeofday|random|random_normal|setseed|array_sample|array_shuffle|gen_random_uuid|lastval|current_query|currtid2)$/,
  ],
  ["takes a refcursor, which nothing the guard allows can open (#254)", /^cursor_to_xml/],
  ["errors outside CREATE EXTENSION / after initdb", /^(pg_extension_config_dump|pg_stop_making_pinned_objects)$/],
];

const allowedBy = (name: string) => ALLOWED.find(([, re]) => re.test(name))?.[0];

describe("the VOLATILE pg_catalog population (#258)", () => {
  it("is the committed PostgreSQL 17 list", () => {
    expect(VOLATILE.length).toBe(234);
  });

  it.each(VOLATILE)("%s is refused or allowed for a stated reason", (name) => {
    const refused = !guardQuery(`SELECT ${name}()`).ok;
    expect(refused || allowedBy(name) !== undefined, `${name} passes the guard and no category explains it`).toBe(true);
  });

  it("every allowed category still matches a function the guard lets through", () => {
    const passing = VOLATILE.filter((n) => guardQuery(`SELECT ${n}()`).ok);
    for (const [reason, re] of ALLOWED) {
      expect(
        passing.some((n) => re.test(n)),
        reason,
      ).toBe(true);
    }
  });
});

describe("the siblings the sweep found (#258)", () => {
  it.each([
    ["SELECT pg_sleep_for('5 seconds')", "PG_SLEEP_FOR"],
    ["SELECT pg_sleep_until(now() + interval '5 seconds')", "PG_SLEEP_UNTIL"],
    ["SELECT pg_log_standby_snapshot()", "PG_LOG_STANDBY_SNAPSHOT"],
    ["SELECT pg_nextoid('pg_class'::regclass, 'oid', 'pg_class_oid_index'::regclass)", "PG_NEXTOID"],
    ["SELECT * FROM pg_hba_file_rules()", "PG_HBA_FILE_RULES"],
    ["SELECT * FROM pg_ident_file_mappings()", "PG_IDENT_FILE_MAPPINGS"],
    ["SELECT * FROM pg_show_all_file_settings()", "PG_SHOW_ALL_FILE_SETTINGS"],
    ["SELECT pg_current_logfile()", "PG_CURRENT_LOGFILE"],
    ["SELECT * FROM pg_catalog.pg_hba_file_rules", "PG_HBA_FILE_RULES"],
  ])("refused: %s", (q, kw) => {
    const r = guardQuery(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(`forbidden keyword present: ${kw}`);
  });

  it.each(["SELECT clock_timestamp()", "SELECT pg_database_size(current_database())", "SELECT sleep_for FROM t"])(
    "still allowed: %s",
    (q) => {
      expect(guardQuery(q)).toEqual({ ok: true });
    },
  );
});
