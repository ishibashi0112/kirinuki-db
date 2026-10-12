import type { JsonValue, Row } from "./types.js";

// Copied from ashiato (github.com/ishibashi0112/ashiato), whose adapters read the same databases.

/**
 * Converts driver values (Date, Buffer, bigint, Decimal objects, ...) into JSON-safe values
 * that can be compared with `===` and written to a cell.
 */
export function normalizeValue(v: unknown): JsonValue {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? v : String(v);
    case "bigint":
      return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v.toString();
  }
  if (v instanceof Date) return dateText(v);
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}`;
  // arrays and JSON values (Postgres arrays, MySQL JSON): compare their whole content
  if (Array.isArray(v)) return stringify(v);
  // driver objects that know their JSON form (oracledb DbObject, decimal libraries)
  const toJSON = (v as { toJSON?: () => unknown }).toJSON;
  if (typeof toJSON === "function") {
    const j = toJSON.call(v);
    return typeof j === "string" ? j : stringify(j);
  }
  // decimal-like objects print their exact value (a JSON document may have a "toString" key that isn't a function)
  const toString = (v as { toString?: unknown }).toString;
  if (typeof toString === "function" && toString !== Object.prototype.toString) return String(v);
  return stringify(v);
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function stringify(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)) ?? "null";
}

/** ISO text, keeping the sub-millisecond digits SQL Server's driver puts in `nanosecondsDelta` (datetime2, time). */
function dateText(d: Date): JsonValue {
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  const extra = (d as Date & { nanosecondsDelta?: number }).nanosecondsDelta;
  if (!extra) return iso;
  const digits = String(Math.round(extra * 1e7)).padStart(4, "0");
  return iso.replace(/Z$/, `${digits}Z`);
}

/**
 * A decimal the driver hands over as text: a plain number when that is exact, otherwise the text
 * without trailing zeros (so 1.50 and 1.5 compare equal). Oracle's thin driver writes 0.5 as ".5".
 */
export function exactDecimal(raw: unknown): JsonValue {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/^(-?)\./, "$10.");
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  const n = Number(s);
  return String(n) === s ? n : s;
}

export function normalizeRow(raw: Record<string, unknown>): Row {
  const row: Row = {};
  for (const [k, v] of Object.entries(raw)) row[k] = normalizeValue(v);
  return row;
}
