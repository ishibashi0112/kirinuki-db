import { exactDecimal, normalizeRow } from "../core/normalize.js";
import type { CatalogTable, Row, TableInfo, TableRef } from "../core/types.js";
import { loadDriver } from "./load.js";
import { databaseName, keyCondition } from "./sql.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/**
 * Types read as the server's text instead of being parsed: dates and times (pg's Date drops
 * microseconds and shifts DATE / TIMESTAMP by the local time zone), intervals, and JSON.
 * date, time, timestamp, timestamptz, timetz, interval, json, jsonb, and their arrays; numeric[]
 * (pg parses it as floats, while plain numeric already stays text). (From ashiato.)
 */
const RAW_TYPES = new Set([1082, 1083, 1114, 1184, 1266, 1186, 114, 3802, 1182, 1183, 1115, 1185, 1270, 1187, 199, 3807, 1231]);
/** bigint and numeric, which pg hands over as text: a number when exact. */
const EXACT_TYPES = new Set([20, 1700]);

/** Mostly for tests that mimic a work database's schema: work databases are SQL Server and Oracle. */
export async function connectPostgres(url: URL): Promise<DbAdapter> {
  const pg = await loadDriver<typeof import("pg")>("pg", "PostgreSQL");
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 1,
    idleTimeoutMillis: 0,
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        RAW_TYPES.has(oid) ? (v: string) => v : EXACT_TYPES.has(oid) ? exactDecimal : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
    },
  });
  // Without a listener, an idle connection being closed by the server would crash the process.
  pool.on("error", () => undefined);
  const query = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Record<string, unknown>[];
  const current = String((await query("SELECT current_schema() AS s"))[0]?.s ?? "public");

  const name = (t: TableRef) => `${q(t.schema ?? current)}.${q(t.name)}`;
  const regclass = (t: TableRef) => [t.schema ?? current, t.name];

  const describe = async (t: TableRef): Promise<TableInfo> => {
    const cols = await query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              col_description(a.attrelid, a.attnum) AS comment, obj_description(a.attrelid, 'pg_class') AS table_comment
         FROM pg_attribute a
        WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      regclass(t),
    );
    const key = await query(
      `SELECT a.attname AS name
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'p' AND c.conrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
        ORDER BY k.ord`,
      regclass(t),
    );
    return {
      table: { schema: t.schema ?? current, name: t.name },
      columns: cols.map((c) => ({ name: String(c.name), type: String(c.type), nullable: Boolean(c.nullable), comment: text(c.comment) })),
      primaryKey: key.map((k) => String(k.name)),
      comment: text(cols[0]?.table_comment),
    };
  };
  const infos = new Map<string, Promise<TableInfo>>();
  const describeCached = (t: TableRef) => {
    let info = infos.get(name(t));
    if (!info) {
      info = describe(t);
      info.catch(() => infos.delete(name(t)));
      infos.set(name(t), info);
    }
    return info;
  };

  return {
    dialect: "postgres",
    label: `PostgreSQL: ${databaseName(url)}`,
    defaultSchema: current,
    async listTables() {
      const rows = await query(
        `SELECT n.nspname AS schema, c.relname AS name
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
            AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
          ORDER BY 1, 2`,
      );
      return rows.map((r) => ({ schema: String(r.schema), name: String(r.name) }));
    },
    describeTable: describeCached,
    async foreignKeys() {
      const rows = await query(
        `SELECT c.conname AS name, fn.nspname AS from_schema, f.relname AS from_table, tn.nspname AS to_schema, t.relname AS to_table,
                (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
                (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_columns
           FROM pg_constraint c
           JOIN pg_class f ON f.oid = c.conrelid JOIN pg_namespace fn ON fn.oid = f.relnamespace
           JOIN pg_class t ON t.oid = c.confrelid JOIN pg_namespace tn ON tn.oid = t.relnamespace
          WHERE c.contype = 'f' AND NOT f.relispartition
          ORDER BY 2, 3, 1`,
      );
      return rows.map((r) => ({
        name: String(r.name),
        from: { schema: String(r.from_schema), name: String(r.from_table) },
        columns: names(r.columns),
        to: { schema: String(r.to_schema), name: String(r.to_table) },
        refColumns: names(r.ref_columns),
      }));
    },
    async catalog(): Promise<CatalogTable[]> {
      const tables = `c.relkind IN ('r', 'p') AND NOT c.relispartition
            AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;
      const cols = await query(
        `SELECT n.nspname AS schema, c.relname AS name, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE ${tables} AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY 1, 2, a.attnum`,
      );
      // key columns only (not INCLUDE ones); an expression index has a 0 among its columns
      const indexes = await query(
        `SELECT n.nspname AS schema, c.relname AS name, i.indisprimary AS is_primary, i.indisunique AS is_unique,
                (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum WHERE k.ord <= i.indnkeyatts) AS columns
           FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE ${tables} AND NOT (0 = ANY (i.indkey::int2[])) AND i.indpred IS NULL
          ORDER BY 1, 2, i.indexrelid`,
      );
      return catalogOf(cols, indexes);
    },
    async countRows(t) {
      return Number((await query(`SELECT COUNT(*) AS n FROM ${name(t)}`))[0]?.n ?? 0);
    },
    async selectRows(t, columns, keys, limit): Promise<Row[]> {
      const info = await describeCached(t);
      const types = new Map(info.columns.map((c) => [c.name, c.type]));
      const params: unknown[] = [];
      const where = keyCondition(columns, keys, q, (c, v) => {
        // bytea values come back as 0x… text (see normalizeValue): the server reads \x… as hex
        params.push(types.get(c) === "bytea" && typeof v === "string" ? v.replace(/^0x/, "\\x") : v);
        return `$${params.length}`;
      });
      const order = info.primaryKey.length ? ` ORDER BY ${info.primaryKey.map(q).join(", ")}` : "";
      return (await query(`SELECT * FROM ${name(t)} WHERE ${where}${order} LIMIT ${Math.max(0, Math.floor(limit))}`, params)).map(normalizeRow);
    },
    async close() {
      await pool.end();
    },
  };
}

/** Builds the catalog from rows of (schema, name, col, type) and (schema, name, is_primary, is_unique, columns). */
function catalogOf(cols: Record<string, unknown>[], indexes: Record<string, unknown>[]): CatalogTable[] {
  const tables = new Map<string, CatalogTable>();
  for (const r of cols) {
    const id = `${String(r.schema)}.${String(r.name)}`;
    let t = tables.get(id);
    if (!t) tables.set(id, (t = { table: { schema: String(r.schema), name: String(r.name) }, columns: [], primaryKey: [], indexes: [] }));
    t.columns.push({ name: String(r.col), type: String(r.type) });
  }
  for (const r of indexes) {
    const t = tables.get(`${String(r.schema)}.${String(r.name)}`);
    if (!t || r.columns === null) continue;
    const columns = names(r.columns);
    if (r.is_primary) t.primaryKey = columns;
    t.indexes.push({ columns, unique: Boolean(r.is_unique) });
  }
  return [...tables.values()];
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
/** pg hands name[] over as an array, or as `{a,b}` text for types it has no parser for. */
const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : String(v).replace(/^\{|\}$/g, "").split(",").map((s) => s.replace(/^"|"$/g, ""));
