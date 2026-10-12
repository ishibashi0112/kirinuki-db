import { MAX_PARAMS } from "../adapters/sql.js";
import type { DbAdapter } from "../adapters/types.js";
import type { ForeignKey, JsonValue, Row, TableInfo, TableRef } from "../core/types.js";

export const DEFAULT_MAX_ROWS = 1000;

export interface PackOptions {
  /** The start table as the user wrote it: orders, sales.orders (any letter case). */
  table: string;
  /** The start row's key values: of the primary key, or of the `by` columns. */
  values: string[];
  /** Columns the values are matched against instead of the primary key (an order number that isn't the key). */
  by?: string[];
  /** Child tables followed although they are not details of their parent (see `isDetail`). */
  children?: string[];
  /** Tables never entered. */
  skip?: string[];
  /** Follow parents only: no child tables, not even details. */
  parentsOnly?: boolean;
  /** Most rows taken from one table. */
  maxRows?: number;
  now?: Date;
}

/** A foreign key, followed from the child to its parent or from the parent to its children. */
export interface Link {
  fk: ForeignKey;
  direction: "parent" | "child";
}

export interface FollowedLink extends Link {
  /** Rows of the pack this link reached (some may have been reached another way first). */
  rows: number;
}

export interface UnfollowedLink extends Link {
  /**
   * reverse: back down the foreign key a parent was reached through (other orders of the same item);
   * not-detail: a child table that isn't a detail and wasn't asked for; parents-only: a detail left out
   * by `parentsOnly`; skipped: asked to skip the table; error: the table could not be read.
   */
  reason: "reverse" | "not-detail" | "parents-only" | "skipped" | "error";
  error?: string;
}

export interface PackTable {
  info: TableInfo;
  /** In primary key order. */
  rows: Row[];
  /** Rows in the whole table; undefined when counting failed. */
  totalRows?: number;
  /** More rows were related than `maxRows`: the table holds only some of them. */
  truncated: boolean;
  /** How the table was first reached; undefined for the start table. */
  via?: Link;
}

export interface Pack {
  /** SQL Server: salesdb */
  database: string;
  defaultSchema?: string;
  start: { table: TableRef; columns: string[]; values: string[] };
  takenAt: Date;
  maxRows: number;
  parentsOnly: boolean;
  /** In the order they were reached: the start table first. */
  tables: PackTable[];
  followed: FollowedLink[];
  /** Relations of the rows in the pack that were not followed: what the pack does not contain. */
  unfollowed: UnfollowedLink[];
  /** The foreign keys of the tables in the pack (the columns that reference another table). */
  foreignKeys: ForeignKey[];
}

/**
 * Collects the rows related to one start row by following declared foreign keys:
 * - parents (the rows a row references: customers of orders, items of order lines) always;
 * - children (the rows referencing a row) when they are details of it — the foreign key is part of
 *   the child's primary key, like order_items (order_id, line_no) — or their table is in `children`;
 * - but never back down the foreign key a parent was reached through: from an item reached through
 *   an order line, the other orders' lines of the same item are not followed.
 * Each row is expanded once, when it is first reached. Breadth first, children before parents.
 */
export async function collectPack(db: DbAdapter, options: PackOptions): Promise<Pack> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error(`行数の上限は1以上の整数にしてください: ${options.maxRows}`);
  const tables = await db.listTables();
  const resolve = (name: string) => resolveTable(name, tables, db.defaultSchema, db.dialect);
  const start = resolve(options.table);
  const children = new Set((options.children ?? []).map((t) => tableId(resolve(t))));
  const skip = new Set((options.skip ?? []).map((t) => tableId(resolve(t))));
  const fks = await db.foreignKeys();

  const infos = new Map<string, Promise<TableInfo>>();
  const describe = (t: TableRef) => {
    let info = infos.get(tableId(t));
    if (!info) infos.set(tableId(t), (info = db.describeTable(t)));
    return info;
  };

  const startInfo = await describe(start);
  const columns = options.by?.length ? options.by.map((c) => resolveColumn(c, startInfo)) : startInfo.primaryKey;
  const startName = tableLabel(start, db.defaultSchema);
  if (columns.length === 0) throw new Error(`${startName} には主キーがありません。--by で探す列を指定してください`);
  if (columns.length !== options.values.length) {
    throw new Error(`${startName} の ${columns.join(", ")} に合わせて、値を${columns.length}個指定してください(指定は${options.values.length}個)`);
  }

  const entries = new Map<string, PackTable & { seen: Set<string> }>();
  const entry = (info: TableInfo, via?: Link) => {
    let e = entries.get(tableId(info.table));
    if (!e) entries.set(tableId(info.table), (e = { info, rows: [], truncated: false, via, seen: new Set() }));
    return e;
  };
  /** Adds the rows not in the pack yet, up to maxRows; returns them. */
  const take = (e: PackTable & { seen: Set<string> }, rows: Row[]) => {
    const fresh: Row[] = [];
    for (const row of rows) {
      const k = rowKey(e.info, row);
      if (e.seen.has(k)) continue;
      if (e.rows.length >= maxRows) {
        e.truncated = true;
        continue;
      }
      e.seen.add(k);
      e.rows.push(row);
      fresh.push(row);
    }
    return fresh;
  };

  const startRows = await db.selectRows(start, columns, [options.values], maxRows + 1);
  if (startRows.length === 0) {
    throw new Error(`${startName} に ${columns.map((c, i) => `${c} = ${options.values[i]}`).join(", ")} の行がありません`);
  }
  const first = entry(startInfo);
  if (startRows.length > maxRows) first.truncated = true;

  interface Step {
    table: PackTable & { seen: Set<string> };
    rows: Row[];
    /** The foreign key this step's rows were reached through, going up to a parent or down to children. */
    up?: ForeignKey;
    down?: ForeignKey;
  }
  const queue: Step[] = [{ table: first, rows: take(first, startRows) }];
  const followed = new Map<string, FollowedLink & { reached: Set<string> }>();
  const unfollowed = new Map<string, UnfollowedLink>();
  const linkId = (l: Link) => `${l.direction}:${tableId(l.fk.from)}:${l.fk.name}`;
  const leaveOut = (l: Link, reason: UnfollowedLink["reason"], error?: string) => {
    if (!unfollowed.has(linkId(l))) unfollowed.set(linkId(l), { ...l, reason, ...(error ? { error } : {}) });
  };

  /** Brings in the rows of `target` whose `targetColumns` equal the `sourceColumns` of `rows`. */
  const follow = async (link: Link, rows: Row[], sourceColumns: string[], target: TableRef, targetColumns: string[]) => {
    const keys = distinctKeys(rows, sourceColumns);
    if (keys.length === 0) return;
    let info: TableInfo;
    let fetched: Row[] = [];
    let overflow = false;
    try {
      info = await describe(target);
      const batch = Math.max(1, Math.floor(MAX_PARAMS / targetColumns.length));
      for (let i = 0; i < keys.length; i += batch) {
        const got = await db.selectRows(target, targetColumns, keys.slice(i, i + batch), maxRows + 1);
        // more related rows than the table may hold, whatever is in it already
        if (got.length > maxRows) overflow = true;
        fetched = fetched.concat(got);
      }
    } catch (err) {
      leaveOut(link, "error", (err as Error).message);
      return;
    }
    // a table the link reached is in the pack even without rows: "this order has no lines" is worth knowing
    const e = entry(info, link);
    if (overflow) e.truncated = true;
    const fresh = take(e, fetched);
    const f = followed.get(linkId(link)) ?? { ...link, rows: 0, reached: new Set<string>() };
    for (const row of fetched) if (e.seen.has(rowKey(e.info, row))) f.reached.add(rowKey(e.info, row));
    f.rows = f.reached.size;
    followed.set(linkId(link), f);
    if (fresh.length) queue.push({ table: e, rows: fresh, ...(link.direction === "parent" ? { up: link.fk } : { down: link.fk }) });
  };

  for (let step = queue.shift(); step; step = queue.shift()) {
    const here = tableId(step.table.info.table);
    // children first: details such as order lines are part of the row itself
    for (const fk of fks.filter((f) => tableId(f.to) === here)) {
      const link: Link = { fk, direction: "child" };
      if (fk === step.up) {
        leaveOut(link, "reverse");
        continue;
      }
      if (skip.has(tableId(fk.from))) {
        leaveOut(link, "skipped");
        continue;
      }
      if (!children.has(tableId(fk.from))) {
        let detail: boolean;
        try {
          detail = isDetail(fk, await describe(fk.from));
        } catch (err) {
          leaveOut(link, "error", (err as Error).message);
          continue;
        }
        if (!detail || options.parentsOnly) {
          leaveOut(link, detail ? "parents-only" : "not-detail");
          continue;
        }
      }
      await follow(link, step.rows, fk.refColumns, fk.from, fk.columns);
    }
    for (const fk of fks.filter((f) => tableId(f.from) === here)) {
      // the parent rows these rows were reached from are in the pack already
      if (fk === step.down) continue;
      const link: Link = { fk, direction: "parent" };
      if (skip.has(tableId(fk.to))) {
        leaveOut(link, "skipped");
        continue;
      }
      await follow(link, step.rows, fk.columns, fk.to, fk.refColumns);
    }
  }

  const packTables: PackTable[] = [];
  for (const { seen: _seen, ...t } of entries.values()) {
    t.rows.sort(byKey(t.info.primaryKey));
    try {
      t.totalRows = await db.countRows(t.info.table);
    } catch {
      // the rows are what matters; the front sheet says the count is unknown
    }
    packTables.push(t);
  }
  return {
    database: db.label,
    defaultSchema: db.defaultSchema,
    start: { table: startInfo.table, columns, values: options.values },
    takenAt: options.now ?? new Date(),
    maxRows,
    parentsOnly: Boolean(options.parentsOnly),
    tables: packTables,
    followed: [...followed.values()].map(({ reached: _reached, ...l }) => l),
    unfollowed: [...unfollowed.entries()].filter(([id]) => !followed.has(id)).map(([, l]) => l),
    foreignKeys: fks.filter((fk) => entries.has(tableId(fk.from))),
  };
}

/** A child table is a detail of its parent when the foreign key is part of its primary key: order_items (order_id, line_no). */
export function isDetail(fk: ForeignKey, child: TableInfo): boolean {
  return child.primaryKey.length > 0 && fk.columns.every((c) => child.primaryKey.includes(c));
}

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

function resolveColumn(input: string, info: TableInfo): string {
  const found = info.columns.find((c) => c.name === input) ?? info.columns.find((c) => c.name.toLowerCase() === input.toLowerCase());
  if (!found) throw new Error(`${info.table.name} に列 ${input} がありません`);
  return found.name;
}

/** The distinct value tuples of `columns` in `rows`, leaving out those with a null (they reference nothing). */
function distinctKeys(rows: Row[], columns: string[]): JsonValue[][] {
  const keys = new Map<string, JsonValue[]>();
  for (const row of rows) {
    const k = columns.map((c) => row[c] ?? null);
    if (k.some((v) => v === null)) continue;
    keys.set(JSON.stringify(k), k);
  }
  return [...keys.values()];
}

const rowKey = (info: TableInfo, row: Row) => JSON.stringify(info.primaryKey.length ? info.primaryKey.map((c) => row[c]) : row);

/** Sorts rows by their primary key: numbers as numbers, the rest as text. */
function byKey(key: string[]) {
  return (a: Row, b: Row) => {
    for (const c of key) {
      const x = a[c] ?? null;
      const y = b[c] ?? null;
      if (x === y) continue;
      if (x === null) return -1;
      if (y === null) return 1;
      if (typeof x === "number" && typeof y === "number") return x - y;
      return String(x) < String(y) ? -1 : 1;
    }
    return 0;
  };
}
