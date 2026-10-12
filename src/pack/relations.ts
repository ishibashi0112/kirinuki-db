import type { DbAdapter } from "../adapters/types.js";
import type { CatalogTable, ForeignKey, TableRef } from "../core/types.js";
import { resolveTable, tableId as id } from "./names.js";

/**
 * Relations a database states without foreign keys. Many work databases declare none: a table that
 * references another one carries the columns of that table's key under the same names (order_items
 * has order_id, the key of orders), and indexes on them. inferRelations finds those; a relations
 * file adds the ones named differently and removes wrong guesses.
 */

const lower = (s: string) => s.toLowerCase();

/** A key of the table: its primary key, otherwise its shortest unique index. */
export function tableKey(t: CatalogTable): { columns: string[]; fromIndex: boolean } | undefined {
  if (t.primaryKey.length) return { columns: t.primaryKey, fromIndex: false };
  const unique = t.indexes.filter((i) => i.unique && i.columns.length).sort((a, b) => a.columns.length - b.columns.length)[0];
  return unique && { columns: unique.columns, fromIndex: true };
}

/** A key made of the same column names is the whole key of this many tables or more: too common a name (id, seq) to tell which table is meant. */
const GENERIC_KEY_TABLES = 3;

/**
 * Guesses relations from names: when table A has columns named like the whole key of table B
 * (any letter case), A references B — unless A's columns already have a declared foreign key, or
 * their types don't go together (a number and a text), or that key is shared by many tables.
 */
export function inferRelations(catalog: CatalogTable[], declared: ForeignKey[]): ForeignKey[] {
  const keyName = (cols: string[]) => cols.map(lower).sort().join(",");
  const keys = catalog.flatMap((t) => {
    const k = tableKey(t);
    return k ? [{ table: t, columns: k.columns }] : [];
  });
  const sharing = new Map<string, number>();
  for (const k of keys) sharing.set(keyName(k.columns), (sharing.get(keyName(k.columns)) ?? 0) + 1);
  // column name → tables having it, to avoid comparing every pair of tables
  const having = new Map<string, Set<CatalogTable>>();
  for (const t of catalog) for (const c of t.columns) having.set(lower(c.name), (having.get(lower(c.name)) ?? new Set()).add(t));
  const covered = new Set(declared.map((fk) => `${id(fk.from)}:${keyName(fk.columns)}`));

  const out: ForeignKey[] = [];
  for (const { table: parent, columns } of keys) {
    if ((sharing.get(keyName(columns)) ?? 0) >= GENERIC_KEY_TABLES) continue;
    const sets = columns.map((c) => having.get(lower(c)) ?? new Set<CatalogTable>());
    for (const child of sets[0] ?? []) {
      if (child === parent || !sets.every((s) => s.has(child))) continue;
      const childColumns = columns.map((c) => child.columns.find((col) => lower(col.name) === lower(c))!);
      if (covered.has(`${id(child.table)}:${keyName(childColumns.map((c) => c.name))}`)) continue;
      const types = columns.map((c) => parent.columns.find((col) => col.name === c)?.type ?? "");
      if (childColumns.some((c, i) => !compatible(c.type, types[i]!))) continue;
      out.push({
        name: `${id(child.table)}(${childColumns.map((c) => c.name).join(",")})->${id(parent.table)}`,
        from: child.table,
        columns: childColumns.map((c) => c.name),
        to: parent.table,
        refColumns: columns,
        source: "inferred",
      });
    }
  }
  return out;
}

type Kind = "number" | "text" | "time";

function kindOf(type: string): Kind | undefined {
  const t = lower(type);
  if (/date|time|interval/.test(t)) return "time";
  if (/char|text|clob|string/.test(t)) return "text";
  if (/int|dec|num|money|float|real|double/.test(t)) return "number";
  return undefined;
}

/** Types that can hold the same values: both numbers, both text, both dates — or unknown (SQLite allows any type name). */
const compatible = (a: string, b: string) => {
  const x = kindOf(a);
  const y = kindOf(b);
  return x === undefined || y === undefined || x === y;
};

/** The child's columns are the leading columns of one of its indexes (its primary key included): the lookup a reference needs. */
export function indexed(fk: ForeignKey, catalog: CatalogTable[]): boolean {
  const child = catalog.find((t) => id(t.table) === id(fk.from));
  const wanted = fk.columns.map(lower).sort().join(",");
  const lead = (cols: string[]) => cols.slice(0, fk.columns.length).map(lower).sort().join(",");
  return Boolean(child && [child.primaryKey, ...child.indexes.map((i) => i.columns)].some((cols) => cols.length && lead(cols) === wanted));
}

/** order_items(item_cd) -> items(item_cd): a line of a relations file. */
export function relationLine(fk: ForeignKey, name: (t: TableRef) => string = (t) => t.name): string {
  return `${name(fk.from)}(${fk.columns.join(", ")}) -> ${name(fk.to)}(${fk.refColumns.join(", ")})`;
}

/** The same relation, whatever its source: the same tables, and each column paired with the same referenced column. */
export const relationId = (fk: ForeignKey) =>
  `${id(fk.from)}->${id(fk.to)}:${fk.columns
    .map((c, i) => `${lower(c)}=${lower(fk.refColumns[i] ?? "")}`)
    .sort()
    .join(",")}`;

/**
 * Reads a relations file: one relation per line, `child(columns) -> parent(columns)`; a line that
 * starts with `!` removes that relation (a wrong guess); `#` starts a comment.
 *
 *   orders(tokui_cd) -> customers(customer_cd)
 *   categories(parent_id) -> categories(category_id)
 *   ! shipments(order_id) -> orders(order_id)
 */
export function parseRelations(
  text: string,
  catalog: CatalogTable[],
  resolve: (name: string) => TableRef,
  fileName = "関係ファイル",
): { add: ForeignKey[]; remove: ForeignKey[] } {
  const add: ForeignKey[] = [];
  const remove: ForeignKey[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const where = `${fileName} ${i + 1}行目`;
    const m = /^(!)?\s*([^\s()]+)\s*\(([^)]*)\)\s*(?:->|→)\s*([^\s()]+)\s*\(([^)]*)\)$/.exec(line);
    if (!m) throw new Error(`${where}: 「子テーブル(列) -> 親テーブル(列)」の形で書いてください: ${raw.trim()}`);
    const side = (tableName: string, cols: string) => {
      let table: TableRef;
      try {
        table = resolve(tableName);
      } catch (e) {
        throw new Error(`${where}: ${(e as Error).message}`);
      }
      const known = catalog.find((t) => id(t.table) === id(table));
      const columns = cols
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
          const col = known?.columns.find((k) => k.name === c) ?? known?.columns.find((k) => lower(k.name) === lower(c));
          if (!col) throw new Error(`${where}: ${tableName} に列 ${c} がありません`);
          return col.name;
        });
      return { table, columns };
    };
    const from = side(m[2]!, m[3]!);
    const to = side(m[4]!, m[5]!);
    if (from.columns.length === 0 || from.columns.length !== to.columns.length) throw new Error(`${where}: 子と親の列の数をそろえてください`);
    const fk: ForeignKey = {
      name: `${id(from.table)}(${from.columns.join(",")})->${id(to.table)}`,
      from: from.table,
      columns: from.columns,
      to: to.table,
      refColumns: to.columns,
      source: "file",
    };
    (m[1] ? remove : add).push(fk);
  });
  return { add, remove };
}

/** Declared foreign keys, guesses and the relations file together: one relation per pair of column lists, the file removing what it says. */
export function mergeRelations(declared: ForeignKey[], inferred: ForeignKey[], file?: { add: ForeignKey[]; remove: ForeignKey[] }): ForeignKey[] {
  const removed = new Set((file?.remove ?? []).map(relationId));
  const out = new Map<string, ForeignKey>();
  for (const fk of [...declared, ...(file?.add ?? []), ...inferred]) {
    const k = relationId(fk);
    if (!removed.has(k) && !out.has(k)) out.set(k, fk);
  }
  return [...out.values()];
}

/** The relations a pack follows: declared, guessed (`infer`) and from a relations file, each list apart and all together. */
export async function loadRelations(
  db: DbAdapter,
  tables: TableRef[],
  options: { infer: boolean; relations?: { name: string; text: string } },
): Promise<{ catalog: CatalogTable[]; declared: ForeignKey[]; inferred: ForeignKey[]; file?: { add: ForeignKey[]; remove: ForeignKey[] }; all: ForeignKey[] }> {
  const catalog = await db.catalog();
  const declared = (await db.foreignKeys()).map((fk) => ({ ...fk, source: "declared" as const }));
  const resolve = (name: string) => resolveTable(name, tables, db.defaultSchema, db.dialect);
  const file = options.relations && parseRelations(options.relations.text, catalog, resolve, options.relations.name);
  const inferred = options.infer ? inferRelations(catalog, declared) : [];
  return { catalog, declared, inferred, file, all: mergeRelations(declared, inferred, file) };
}
