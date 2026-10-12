import type { TableRef } from "../core/types.js";

export const tableId = (t: TableRef) => (t.schema === undefined ? t.name : `${t.schema}.${t.name}`);

/** The table's name as shown to people: with its schema only when that isn't the default one. */
export const tableLabel = (t: TableRef, defaultSchema?: string) => (t.schema && t.schema !== defaultSchema ? `${t.schema}.${t.name}` : t.name);

/** Finds a table the user named: orders or sales.orders, in any letter case (Oracle's names are upper case). */
export function resolveTable(input: string, tables: TableRef[], defaultSchema: string | undefined, dialect?: string): TableRef {
  const wanted = input.trim();
  const dot = wanted.indexOf(".");
  const schema = dot > 0 ? wanted.slice(0, dot) : undefined;
  const name = dot > 0 ? wanted.slice(dot + 1) : wanted;
  const same = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase();
  let found = tables.filter((t) => same(t.name, name) && (schema === undefined || same(t.schema, schema)));
  if (found.length > 1) {
    const exact = found.filter((t) => t.name === name);
    if (exact.length) found = exact;
  }
  if (found.length > 1 && schema === undefined) {
    const inDefault = found.filter((t) => t.schema === defaultSchema);
    if (inDefault.length === 1) found = inDefault;
  }
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new Error(`${input} は複数のスキーマにあります: ${found.map((t) => tableId(t)).join(", ")}。スキーマ付きで指定してください`);
  const hint = dialect === "oracle" ? `(ほかのユーザーのテーブルなら、接続URLに ?schema=所有者 を付けてください)` : "";
  throw new Error(`テーブル ${input} が見つかりません${hint}`);
}
