import type { JsonValue } from "../core/types.js";

/** Most parameters one query binds: well under SQL Server's 2,100 and Oracle's 1,000-item IN lists. */
export const MAX_PARAMS = 500;

/**
 * WHERE condition matching any of the key tuples: `a IN (…)` for one column, otherwise
 * `(a = … AND b = …) OR …` (SQL Server has no row-value IN). `param` binds one value and returns
 * its placeholder expression.
 */
export function keyCondition(
  columns: string[],
  keys: JsonValue[][],
  col: (name: string) => string,
  param: (column: string, value: JsonValue) => string,
): string {
  if (keys.length === 0) return "1 = 0";
  if (columns.length === 1) {
    const c = columns[0]!;
    return `${col(c)} IN (${keys.map((k) => param(c, k[0] ?? null)).join(", ")})`;
  }
  return keys.map((k) => `(${columns.map((c, i) => `${col(c)} = ${param(c, k[i] ?? null)}`).join(" AND ")})`).join(" OR ");
}

/** The part of a URL's path that names the database, for the pack's front sheet. */
export const databaseName = (url: URL) => decodeURIComponent(url.pathname.replace(/^\//, ""));
