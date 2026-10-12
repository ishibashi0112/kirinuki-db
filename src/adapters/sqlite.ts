import { basename } from "node:path";
import { normalizeRow } from "../core/normalize.js";
import type { ForeignKey, Row, TableInfo, TableRef } from "../core/types.js";
import { keyCondition } from "./sql.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Opened read-only. Mostly for trying the tool and for tests: work databases are SQL Server and Oracle. */
export async function connectSqlite(path: string): Promise<DbAdapter> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });

  const all = (sql: string, params: (string | number | null)[] = []) => {
    const stmt = db.prepare(sql);
    // integers beyond 2^53 would otherwise throw; normalizeValue turns safe ones back into numbers
    stmt.setReadBigInts(true);
    return stmt.all(...params) as Record<string, unknown>[];
  };

  const tables = () =>
    all(
      `SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
    ).map((r) => String(r.name));

  const columnsOf = (t: TableRef) => all(`PRAGMA table_info(${q(t.name)})`);
  const primaryKey = (t: TableRef) =>
    columnsOf(t)
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => String(c.name));

  return {
    dialect: "sqlite",
    label: `SQLite: ${basename(path)}`,
    async listTables() {
      return tables().map((name) => ({ name }));
    },
    async describeTable(t): Promise<TableInfo> {
      const cols = columnsOf(t);
      if (cols.length === 0) throw new Error(`Table not found: ${t.name}`);
      return {
        table: { name: t.name },
        columns: cols.map((c) => ({ name: String(c.name), type: String(c.type ?? ""), nullable: Number(c.notnull) === 0 && Number(c.pk) === 0 })),
        primaryKey: primaryKey(t),
      };
    },
    async foreignKeys() {
      const fks: ForeignKey[] = [];
      for (const name of tables()) {
        const byId = new Map<number, Record<string, unknown>[]>();
        for (const r of all(`PRAGMA foreign_key_list(${q(name)})`)) {
          const id = Number(r.id);
          byId.set(id, [...(byId.get(id) ?? []), r]);
        }
        for (const [id, parts] of byId) {
          parts.sort((a, b) => Number(a.seq) - Number(b.seq));
          const to = String(parts[0]!.table);
          // REFERENCES parent without columns means the parent's primary key
          const refColumns = parts.every((p) => p.to !== null) ? parts.map((p) => String(p.to)) : primaryKey({ name: to });
          fks.push({ name: `${name}_fk${id}`, from: { name }, columns: parts.map((p) => String(p.from)), to: { name: to }, refColumns });
        }
      }
      return fks;
    },
    async countRows(t) {
      return Number(all(`SELECT COUNT(*) AS n FROM ${q(t.name)}`)[0]?.n ?? 0);
    },
    async selectRows(t, columns, keys, limit): Promise<Row[]> {
      const params: (string | number | null)[] = [];
      const where = keyCondition(columns, keys, q, (_c, v) => {
        params.push(typeof v === "boolean" ? Number(v) : v);
        return "?";
      });
      const key = primaryKey(t);
      const order = key.length ? ` ORDER BY ${key.map(q).join(", ")}` : "";
      return all(`SELECT * FROM ${q(t.name)} WHERE ${where}${order} LIMIT ${Math.max(0, Math.floor(limit))}`, params).map(normalizeRow);
    },
    async close() {
      db.close();
    },
  };
}
