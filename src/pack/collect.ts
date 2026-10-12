import { MAX_PARAMS } from "../adapters/sql.js";
import type { DbAdapter } from "../adapters/types.js";
import type { CatalogTable, ForeignKey, JsonValue, Row, TableInfo, TableRef } from "../core/types.js";
import { resolveTable, tableId, tableLabel } from "./names.js";
import { loadRelations, tableKey } from "./relations.js";

export { resolveTable, tableId, tableLabel } from "./names.js";

export const DEFAULT_MAX_ROWS = 1000;
/**
 * Most rows of a detail table followed from a row reached as a parent. Stock per item is a few rows;
 * every customer of a company (a company code leading every key) is not part of an order.
 */
export const DETAIL_LIMIT = 100;

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
  /** Guess relations from column names (see inferRelations). Default true. */
  infer?: boolean;
  /** A relations file's text (see parseRelations) and its name for messages. */
  relations?: { name: string; text: string };
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
   * by `parentsOnly`; too-many: a detail of a row reached as a parent with more than DETAIL_LIMIT rows;
   * skipped: asked to skip the table; error: the table could not be read.
   */
  reason: "reverse" | "not-detail" | "parents-only" | "too-many" | "skipped" | "error";
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
  /** Relations were guessed from column names too. */
  inferred: boolean;
  /** Name of the relations file used. */
  relationsFile?: string;
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
 *   an order line, the other orders' lines of the same item are not followed;
 * - and details of a row reached as a parent only when they are few (DETAIL_LIMIT), and not at all
 *   when that parent was reached from one of its details (the other orders of an order's company).
 * Relations are the declared foreign keys, those guessed from column names (`infer`), and those of a
 * relations file. Each row is expanded once, when it is first reached. Breadth first, children before parents.
 */
export async function collectPack(db: DbAdapter, options: PackOptions): Promise<Pack> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error(`行数の上限は1以上の整数にしてください: ${options.maxRows}`);
  const tables = await db.listTables();
  const resolve = (name: string) => resolveTable(name, tables, db.defaultSchema, db.dialect);
  const start = resolve(options.table);
  const children = new Set((options.children ?? []).map((t) => tableId(resolve(t))));
  const skip = new Set((options.skip ?? []).map((t) => tableId(resolve(t))));
  const infer = options.infer ?? true;
  const { catalog, all: fks } = await loadRelations(db, tables, { infer, relations: options.relations });

  const cataloged = new Map<string, CatalogTable>(catalog.map((t) => [tableId(t.table), t]));
  const infos = new Map<string, Promise<TableInfo>>();
  const describe = (t: TableRef) => {
    let info = infos.get(tableId(t));
    if (!info) {
      // a table without a primary key is keyed by its unique index, if it has one
      const key = cataloged.get(tableId(t)) && tableKey(cataloged.get(tableId(t))!);
      info = db.describeTable(t).then((i) => (i.primaryKey.length || !key ? i : { ...i, primaryKey: key.columns, keyFromIndex: true }));
      infos.set(tableId(t), info);
    }
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
    /** A step on the way here went up to a parent. */
    viaParent?: boolean;
    /** Reached by going up from one of this table's details (a company from its orders): its other details are someone else's. */
    container?: boolean;
  }
  const queue: Step[] = [{ table: first, rows: take(first, startRows) }];
  const followed = new Map<string, FollowedLink & { reached: Set<string> }>();
  const unfollowed = new Map<string, UnfollowedLink>();
  const linkId = (l: Link) => `${l.direction}:${tableId(l.fk.from)}:${l.fk.name}`;
  const leaveOut = (l: Link, reason: UnfollowedLink["reason"], error?: string) => {
    if (!unfollowed.has(linkId(l))) unfollowed.set(linkId(l), { ...l, reason, ...(error ? { error } : {}) });
  };

  /**
   * Brings in the rows of `target` whose `targetColumns` equal the `sourceColumns` of `step`'s rows.
   * With `few`, brings in nothing when there are more than that many.
   */
  const follow = async (link: Link, step: Step, sourceColumns: string[], target: TableRef, targetColumns: string[], few?: number) => {
    const keys = distinctKeys(step.rows, sourceColumns);
    if (keys.length === 0) return;
    let info: TableInfo;
    let fetched: Row[] = [];
    let overflow = false;
    try {
      info = await describe(target);
      const batch = Math.max(1, Math.floor(MAX_PARAMS / targetColumns.length));
      for (let i = 0; i < keys.length; i += batch) {
        const got = await db.selectRows(target, targetColumns, keys.slice(i, i + batch), (few ?? maxRows) + 1);
        // more related rows than the table may hold, whatever is in it already
        if (got.length > maxRows) overflow = true;
        fetched = fetched.concat(got);
        if (few !== undefined && fetched.length > few) {
          leaveOut(link, "too-many");
          return;
        }
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
    if (fresh.length) {
      const up = link.direction === "parent";
      queue.push({
        table: e,
        rows: fresh,
        viaParent: step.viaParent || up,
        container: up && isDetail(link.fk, step.table.info),
        ...(up ? { up: link.fk } : { down: link.fk }),
      });
    }
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
      const asked = children.has(tableId(fk.from));
      if (!asked) {
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
        // the other orders of the company an order belongs to
        if (step.container) {
          leaveOut(link, "reverse");
          continue;
        }
      }
      await follow(link, step, fk.refColumns, fk.from, fk.columns, step.viaParent && !asked ? DETAIL_LIMIT : undefined);
    }
    for (const fk of fks.filter((f) => tableId(f.from) === here)) {
      // the parent rows these rows were reached from are in the pack already
      if (fk === step.down) continue;
      const link: Link = { fk, direction: "parent" };
      if (skip.has(tableId(fk.to))) {
        leaveOut(link, "skipped");
        continue;
      }
      await follow(link, step, fk.columns, fk.to, fk.refColumns);
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
    inferred: infer,
    relationsFile: options.relations?.name,
    tables: packTables,
    followed: [...followed.values()].map(({ reached: _reached, ...l }) => l),
    unfollowed: [...unfollowed.entries()].filter(([id]) => !followed.has(id)).map(([, l]) => l),
    foreignKeys: fks.filter((fk) => entries.has(tableId(fk.from))),
  };
}

/**
 * A child table is a detail of its parent when the foreign key leads its key: order_items (order_id, line_no)
 * of orders, stock (item_cd, wh_cd) of items — but not of warehouses, nor a link table of the table its second column references.
 */
export function isDetail(fk: ForeignKey, child: TableInfo): boolean {
  const lead = child.primaryKey.slice(0, fk.columns.length);
  return lead.length === fk.columns.length && fk.columns.every((c) => lead.includes(c));
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
