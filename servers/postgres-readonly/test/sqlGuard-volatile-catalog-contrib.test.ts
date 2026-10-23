/**
 * Every VOLATILE function a contrib or PL extension installs is either refused
 * or allowed for a stated reason (#331).
 *
 * #258's sweep (sqlGuard-volatile-catalog.test.ts) read pg_catalog only.
 * Extension functions are created in the extension's schema, so the contrib
 * side-effect functions never entered that population. Measured on Postgres
 * 17.6 under `default_transaction_read_only = on`, each passing `guardQuery`
 * on main:
 *
 *   heap_force_kill('victim'::regclass, ARRAY['(0,1)','(0,2)']::tid[])
 *                              victim: 5 rows -> 3, permanently
 *   heap_force_freeze('v2'::regclass, ARRAY['(0,1)']::tid[])   ran
 *   pg_buffercache_evict(<bufferid>)                         returned t
 *
 * The population is `test/fixtures/pg17-contrib-volatile-functions.txt`, made
 * from pg_proc joined through pg_depend to pg_extension (the command is in its
 * header). Every category below lists its functions BY NAME, not with a
 * pattern. A new contrib function from a regenerate, or one a narrowed list
 * entry starts allowing, therefore fails here until someone writes down why it
 * is safe.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { guardQuery } from "../src/sqlGuard.js";

const CONTRIB = readFileSync(new URL("./fixtures/pg17-contrib-volatile-functions.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => {
    const [ext, name] = line.split(" ");
    return { ext, name };
  });

// [reason, function names]. Each reason was checked against Postgres 17.6.
const ALLOWED: Array<[string, string[]]> = [
  [
    "trigger functions: error unless the trigger manager calls them",
    [
      "autoinc",
      "insert_username",
      "moddatetime",
      "check_foreign_key",
      "check_primary_key",
      "triggered_change_notification",
    ],
  ],
  [
    "handlers, validators, text-search dictionary, tablesample and aggregate-support callbacks (internal arguments)",
    [
      "blhandler",
      "dintdict_init",
      "dintdict_lexize",
      "dxsyn_init",
      "dxsyn_lexize",
      "unaccent_init",
      "unaccent_lexize",
      "file_fdw_handler",
      "file_fdw_validator",
      "postgres_fdw_handler",
      "postgres_fdw_validator",
      "int_agg_state",
      "int_agg_final_array",
      "system_rows",
      "system_time",
      "plperl_call_handler",
      "plperl_inline_handler",
      "plperl_validator",
      "plperlu_call_handler",
      "plperlu_inline_handler",
      "plperlu_validator",
      "plpgsql_call_handler",
      "plpgsql_inline_handler",
      "plpgsql_validator",
      "pltcl_call_handler",
      "pltclu_call_handler",
    ],
  ],
  [
    "read-only inspectors of this database's pages, indexes, visibility map, row locks and statement stats (bt_index_parent_check takes a ShareLock until the per-call transaction ends)",
    [
      "bt_index_check",
      "bt_index_parent_check",
      "verify_heapam",
      "brin_metapage_info",
      "brin_page_items",
      "brin_page_type",
      "brin_revmap_data",
      "bt_metap",
      "bt_multi_page_stats",
      "bt_page_items",
      "bt_page_stats",
      "fsm_page_contents",
      "get_raw_page",
      "gin_leafpage_items",
      "gin_metapage_info",
      "gin_page_opaque_info",
      "gist_page_items",
      "gist_page_items_bytea",
      "gist_page_opaque_info",
      "hash_bitmap_info",
      "hash_metapage_info",
      "hash_page_items",
      "hash_page_stats",
      "hash_page_type",
      "heap_page_item_attrs",
      "heap_page_items",
      "heap_tuple_infomask_flags",
      "page_checksum",
      "page_header",
      "tuple_data_split",
      "pg_buffercache_pages",
      "pg_buffercache_summary",
      "pg_buffercache_usage_counts",
      "pg_freespace",
      "pg_check_frozen",
      "pg_check_visible",
      "pg_visibility",
      "pg_visibility_map",
      "pg_visibility_map_summary",
      "pgrowlocks",
      "pg_relpages",
      "pgstatginindex",
      "pgstathashindex",
      "pgstatindex",
      "pgstattuple",
      "pgstattuple_approx",
      "pg_stat_statements",
      "pg_stat_statements_info",
      "postgres_fdw_get_connections",
    ],
  ],
  [
    "volatile only because the answer changes: random output, or this connection's own TLS state (uuid_generate_v1 embeds the host MAC address)",
    [
      "gen_random_bytes",
      "gen_random_uuid",
      "gen_salt",
      "pgp_pub_encrypt",
      "pgp_pub_encrypt_bytea",
      "pgp_sym_encrypt",
      "pgp_sym_encrypt_bytea",
      "normal_rand",
      "uuid_generate_v1",
      "uuid_generate_v1mc",
      "uuid_generate_v4",
      "ssl_cipher",
      "ssl_client_cert_present",
      "ssl_client_dn",
      "ssl_client_dn_field",
      "ssl_client_serial",
      "ssl_extension_info",
      "ssl_is_used",
      "ssl_issuer_dn",
      "ssl_issuer_field",
      "ssl_version",
    ],
  ],
  [
    "session-local, and db.ts opens a fresh client for every call and closes it afterwards",
    ["set_limit", "postgres_fdw_disconnect", "postgres_fdw_disconnect_all"],
  ],
  [
    "xml2 turns off libxslt file and network access (measured: document() on a readable server XML file logs 'Local file read ... refused')",
    ["xslt_process"],
  ],
  [
    "pg_walinspect reads the cluster's WAL, including other databases' rows; whether to refuse it is #333",
    ["pg_get_wal_block_info", "pg_get_wal_record_info", "pg_get_wal_records_info", "pg_get_wal_stats"],
  ],
];

const allowedBy = (name: string) => ALLOWED.find(([, names]) => names.includes(name))?.[0];

describe("the VOLATILE contrib-extension population (#331)", () => {
  it("is the committed PostgreSQL 17 list", () => {
    expect(CONTRIB.length).toBe(140);
  });

  it.each(CONTRIB.map(({ ext, name }) => [ext, name]))("%s.%s is refused or allowed for a stated reason", (_ext, name) => {
    const refused = !guardQuery(`SELECT ${name}()`).ok;
    expect(refused || allowedBy(name) !== undefined, `${name} passes the guard and no category explains it`).toBe(true);
  });

  it("every allowlisted name is in the population and still passes the guard", () => {
    const names = new Set(CONTRIB.map(({ name }) => name));
    for (const [reason, list] of ALLOWED) {
      for (const name of list) {
        expect(names.has(name), `${name} (${reason}) is not in the fixture`).toBe(true);
        expect(guardQuery(`SELECT ${name}()`).ok, `${name} is refused, so "${reason}" no longer applies`).toBe(true);
      }
    }
  });
});

describe("the contrib side-effect functions the sweep found (#331)", () => {
  it.each([
    ["SELECT heap_force_kill('victim'::regclass, ARRAY['(0,1)','(0,2)']::tid[])", "HEAP_FORCE_"],
    ["SELECT heap_force_freeze('victim'::regclass, ARRAY['(0,1)']::tid[])", "HEAP_FORCE_"],
    ["SELECT public.heap_force_kill('victim'::regclass, ARRAY['(0,1)']::tid[])", "HEAP_FORCE_"],
    ["SELECT pg_buffercache_evict(1)", "PG_BUFFERCACHE_EVICT"],
    [
      "SELECT pg_buffercache_evict(bufferid) FROM pg_buffercache WHERE relfilenode = pg_relation_filenode('t')",
      "PG_BUFFERCACHE_EVICT",
    ],
    // PostgreSQL 18 (pg_buffercache 1.6) siblings; not in the PG17 fixture.
    ["SELECT * FROM pg_buffercache_evict_relation('t'::regclass)", "PG_BUFFERCACHE_EVICT"],
    ["SELECT * FROM pg_buffercache_evict_all()", "PG_BUFFERCACHE_EVICT"],
  ])("refused: %s", (q, pfx) => {
    const r = guardQuery(q);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(`forbidden function family: ${pfx}*`);
  });

  it.each([
    "SELECT * FROM pg_buffercache",
    "SELECT * FROM pg_buffercache_summary()",
    "SELECT * FROM pg_buffercache_usage_counts()",
    "SELECT * FROM pgstattuple('t')",
    "SELECT * FROM heap_page_items(get_raw_page('t', 0))",
    "SELECT heap_tuple_infomask_flags(2304, 1)",
  ])("still allowed: %s", (q) => {
    expect(guardQuery(q)).toEqual({ ok: true });
  });
});
