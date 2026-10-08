import pg from "pg";

/**
 * `timestamptz` parsing that keeps every instant Postgres can hold (#249).
 *
 * #207 left `timestamptz` on pg's default parser because it is an instant, not
 * a calendar value. A JS `Date` still cannot hold two kinds of instant:
 *   - microseconds: Postgres keeps six fractional digits (`now()` fills them),
 *     `Date` keeps three, so `.123456` and `.123999` became the same `.123Z`;
 *   - years past 275760: Postgres allows up to 294276, where `Date` is invalid
 *     and `JSON.stringify` wrote it as `null`, which a client reads as SQL NULL.
 *
 * Output keeps pg's ISO-8601 UTC form, so a value with millisecond precision or
 * coarser is byte-identical to before. Only the fraction carries the database's
 * own digits. A value outside `Date`'s range is returned as the database's
 * text. `±infinity` keeps pg's `±Infinity`, which the payload replacer names.
 */
export const TIMESTAMPTZ_OID = 1184;
export const TIMESTAMPTZ_ARRAY_OID = 1185;
const TEXT_ARRAY_OID = 1009;

// pg's typings key `getTypeParser` on its `TypeId` enum, which omits the array
// oids; the runtime takes any oid.
const getTypeParser = pg.types.getTypeParser as (oid: number, format?: string) => (value: string) => unknown;
const pgTimestamptz = getTypeParser(TIMESTAMPTZ_OID, "text");
const FRACTION = /\d{2}:\d{2}:\d{2}\.(\d+)/;

export function parseTimestamptz(value: string): unknown {
  const parsed = pgTimestamptz(value);
  if (!(parsed instanceof Date)) return parsed;
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return value;
  // pg truncates the fraction to whole milliseconds (it never rounds up into
  // the next second), so the whole second is exact and the digits come from
  // the text.
  const iso = new Date(Math.floor(ms / 1000) * 1000).toISOString();
  const digits = (FRACTION.exec(value)?.[1] ?? "").padEnd(3, "0");
  return `${iso.slice(0, -5)}.${digits}Z`;
}

function mapElements(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mapElements);
  return typeof value === "string" ? parseTimestamptz(value) : value;
}

/** pg's `getTypeParser`, with `timestamptz` and its array kept exact (#249). */
export function exactTimestamptzParser(oid: number, format?: string): (value: string) => unknown {
  if (oid === TIMESTAMPTZ_OID) return parseTimestamptz;
  if (oid === TIMESTAMPTZ_ARRAY_OID) {
    const parseTextArray = getTypeParser(TEXT_ARRAY_OID, format ?? "text");
    return (value: string) => mapElements(parseTextArray(value));
  }
  return getTypeParser(oid, format);
}
