import { exactDecimal, normalizeRow } from "../core/normalize.js";
import type { CatalogTable, ForeignKey, JsonValue, Row, TableInfo, TableRef } from "../core/types.js";
import { loadDriver } from "./load.js";
import { databaseName, keyCondition } from "./sql.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `[${id.replace(/]/g, "]]")}]`;
const ALIAS = "k";

const DATE_TYPES = new Set(["date", "time", "datetime", "datetime2", "smalldatetime", "datetimeoffset"]);
const BINARY_TYPES = new Set(["binary", "varbinary", "image", "timestamp"]);

interface ColumnMeta {
  name: string;
  /** System type name: int, varchar, datetime2… */
  base: string;
  /** The type as written in a CREATE TABLE: varchar(10), decimal(10,2)… */
  type: string;
  /** decimal / numeric precision. */
  precision: number;
  nullable: boolean;
  comment?: string;
}

/**
 * mssql://user:password@host:1433/database?instance=SQLEXPRESS&encrypt=true&domain=CORP
 * (domain: Windows / NTLM login with the user and password of that domain). Connection code from ashiato.
 */
export async function connectMssql(url: URL): Promise<DbAdapter> {
  const mssql = await loadDriver<typeof import("mssql")>("mssql", "SQL Server");
  const params = url.searchParams;
  const pool = await new mssql.ConnectionPool({
    server: url.hostname,
    port: url.port ? Number(url.port) : params.get("instance") ? undefined : 1433,
    user: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    domain: params.get("domain") ?? undefined,
    database: databaseName(url) || undefined,
    // a table without an index on the key columns can take longer than the 15s default
    requestTimeout: Number(params.get("requestTimeout") ?? 120_000),
    options: {
      encrypt: params.get("encrypt") === "true",
      trustServerCertificate: params.get("trustServerCertificate") !== "false",
      instanceName: params.get("instance") ?? undefined,
      readOnlyIntent: params.get("applicationIntent")?.toLowerCase() === "readonly",
    },
  }).connect();

  type Input = { name: string; type: Parameters<import("mssql").Request["input"]>[1]; value: unknown };
  const query = async (sql: string, inputs: Input[] = []) => {
    const req = pool.request();
    for (const i of inputs) req.input(i.name, i.type, i.value);
    return (await req.query(sql)).recordset as Record<string, unknown>[];
  };
  const text = (name: string, value: string): Input => ({ name, type: mssql.NVarChar, value });

  const current = (await query("SELECT SCHEMA_NAME() AS s, DB_NAME() AS d"))[0] ?? {};
  const defaultSchema = String(current.s ?? "dbo");
  const name = (t: TableRef) => `${q(t.schema ?? defaultSchema)}.${q(t.name)}`;

  const describe = async (t: TableRef): Promise<TableInfo & { meta: ColumnMeta[] }> => {
    const cols = await query(
      `SELECT c.name, COALESCE(TYPE_NAME(c.system_type_id), TYPE_NAME(c.user_type_id)) AS base, c.max_length, c.precision, c.scale,
              c.is_nullable, CAST(ep.value AS nvarchar(4000)) AS comment
         FROM sys.columns c
         LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
        WHERE c.object_id = OBJECT_ID(@t) AND ISNULL(COLUMNPROPERTY(c.object_id, c.name, 'IsHidden'), 0) = 0
        ORDER BY c.column_id`,
      [text("t", name(t))],
    );
    if (cols.length === 0) throw new Error(`Table not found: ${name(t)}`);
    const key = await query(
      `SELECT c.name FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.object_id = OBJECT_ID(@t) AND i.is_primary_key = 1 AND ic.key_ordinal > 0
        ORDER BY ic.key_ordinal`,
      [text("t", name(t))],
    );
    const tableComment = await query(
      `SELECT CAST(value AS nvarchar(4000)) AS comment FROM sys.extended_properties
        WHERE class = 1 AND major_id = OBJECT_ID(@t) AND minor_id = 0 AND name = 'MS_Description'`,
      [text("t", name(t))],
    );
    const meta = cols.map((c) => ({
      name: String(c.name),
      base: String(c.base),
      type: typeText(String(c.base), Number(c.max_length), Number(c.precision), Number(c.scale)),
      precision: Number(c.precision),
      nullable: Boolean(c.is_nullable),
      comment: nonEmpty(c.comment),
    }));
    return {
      table: { schema: t.schema ?? defaultSchema, name: t.name },
      columns: meta.map(({ name, type, nullable, comment }) => ({ name, type, nullable, comment })),
      primaryKey: key.map((k) => String(k.name)),
      comment: nonEmpty(tableComment[0]?.comment),
      meta,
    };
  };
  const infos = new Map<string, ReturnType<typeof describe>>();
  const describeCached = (t: TableRef) => {
    let info = infos.get(name(t));
    if (!info) {
      info = describe(t);
      info.catch(() => infos.delete(name(t)));
      infos.set(name(t), info);
    }
    return info;
  };

  /**
   * tedious reads DECIMAL / NUMERIC and MONEY as floating point numbers, which rounds values with
   * more than 15 significant digits: such columns are read as text, as are dates and times (a Date
   * would carry a made-up time zone). BIGINT comes as text. All are then a number when exact.
   */
  const wide = (c: ColumnMeta) => c.base === "money" || (/^(decimal|numeric)$/.test(c.base) && c.precision > 15);
  const selectList = (meta: ColumnMeta[]) =>
    meta
      .map((c) => {
        const col = `${ALIAS}.${q(c.name)}`;
        if (DATE_TYPES.has(c.base)) return `CONVERT(varchar(40), ${col}, 121) AS ${q(c.name)}`;
        if (wide(c)) return `CONVERT(varchar(50), ${col}${c.base === "money" ? ", 2" : ""}) AS ${q(c.name)}`;
        return col;
      })
      .join(", ");

  /** A key value bound with a type that makes SQL Server convert it, not the column, so that indexes are used. */
  const bind = (c: ColumnMeta | undefined, value: JsonValue, n: string): { input: Input; expr: string } => {
    const p = `@${n}`;
    const base = c?.base ?? "";
    if (BINARY_TYPES.has(base) && typeof value === "string" && value.startsWith("0x")) {
      return { input: { name: n, type: mssql.VarBinary, value: Buffer.from(value.slice(2), "hex") }, expr: p };
    }
    const s = typeof value === "number" ? plainNumber(value) : String(value);
    if (DATE_TYPES.has(base)) return { input: { name: n, type: mssql.VarChar, value: s }, expr: `CONVERT(${c!.type}, ${p}, 121)` };
    if (base === "uniqueidentifier") return { input: { name: n, type: mssql.UniqueIdentifier, value: s }, expr: p };
    // nvarchar would make SQL Server convert a varchar column instead; other characters need it anyway
    const unicode = /^n(var)?char$|^ntext$/.test(base) || /[^\x00-\x7f]/.test(s);
    return { input: { name: n, type: unicode ? mssql.NVarChar : mssql.VarChar, value: s }, expr: p };
  };

  return {
    dialect: "mssql",
    label: `SQL Server: ${databaseName(url) || String(current.d ?? "")}`,
    defaultSchema,
    async listTables() {
      const rows = await query(
        `SELECT s.name AS sch, o.name AS tbl FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE o.type = 'U' AND o.is_ms_shipped = 0 ORDER BY s.name, o.name`,
      );
      return rows.map((r) => ({ schema: String(r.sch), name: String(r.tbl) }));
    },
    async describeTable(t) {
      const { meta: _meta, ...info } = await describeCached(t);
      return info;
    },
    async foreignKeys() {
      // only between tables this user can see: the others' names are not visible
      const rows = await query(
        `SELECT fk.object_id AS id, fk.name, SCHEMA_NAME(ft.schema_id) AS from_schema, ft.name AS from_table, fc.name AS from_column,
                SCHEMA_NAME(tt.schema_id) AS to_schema, tt.name AS to_table, tc.name AS to_column
           FROM sys.foreign_keys fk
           JOIN sys.foreign_key_columns k ON k.constraint_object_id = fk.object_id
           JOIN sys.tables ft ON ft.object_id = fk.parent_object_id
           JOIN sys.columns fc ON fc.object_id = k.parent_object_id AND fc.column_id = k.parent_column_id
           JOIN sys.tables tt ON tt.object_id = fk.referenced_object_id
           JOIN sys.columns tc ON tc.object_id = k.referenced_object_id AND tc.column_id = k.referenced_column_id
          ORDER BY from_schema, from_table, fk.name, k.constraint_column_id`,
      );
      const byId = new Map<string, ForeignKey>();
      for (const r of rows) {
        const id = String(r.id);
        let fk = byId.get(id);
        if (!fk) {
          fk = {
            name: String(r.name),
            from: { schema: String(r.from_schema), name: String(r.from_table) },
            columns: [],
            to: { schema: String(r.to_schema), name: String(r.to_table) },
            refColumns: [],
          };
          byId.set(id, fk);
        }
        fk.columns.push(String(r.from_column));
        fk.refColumns.push(String(r.to_column));
      }
      return [...byId.values()];
    },
    async catalog() {
      const cols = await query(
        `SELECT SCHEMA_NAME(t.schema_id) AS sch, t.name AS tbl, c.name AS col,
                COALESCE(TYPE_NAME(c.system_type_id), TYPE_NAME(c.user_type_id)) AS base, c.max_length, c.precision, c.scale
           FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id
          WHERE t.is_ms_shipped = 0 AND ISNULL(COLUMNPROPERTY(c.object_id, c.name, 'IsHidden'), 0) = 0
          ORDER BY sch, tbl, c.column_id`,
      );
      // clustered and nonclustered row-store indexes, without filtered ones (their uniqueness covers some rows only)
      const indexes = await query(
        `SELECT SCHEMA_NAME(t.schema_id) AS sch, t.name AS tbl, i.index_id, i.is_primary_key, i.is_unique, c.name AS col
           FROM sys.tables t
           JOIN sys.indexes i ON i.object_id = t.object_id
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE t.is_ms_shipped = 0 AND i.type IN (1, 2) AND i.is_hypothetical = 0 AND i.has_filter = 0
          ORDER BY sch, tbl, i.index_id, ic.key_ordinal`,
      );
      const tables = new Map<string, CatalogTable>();
      for (const r of cols) {
        const id = `${String(r.sch)}.${String(r.tbl)}`;
        let t = tables.get(id);
        if (!t) tables.set(id, (t = { table: { schema: String(r.sch), name: String(r.tbl) }, columns: [], primaryKey: [], indexes: [] }));
        t.columns.push({ name: String(r.col), type: typeText(String(r.base), Number(r.max_length), Number(r.precision), Number(r.scale)) });
      }
      let current: { columns: string[]; unique: boolean } | undefined;
      let currentId = "";
      for (const r of indexes) {
        const t = tables.get(`${String(r.sch)}.${String(r.tbl)}`);
        if (!t) continue;
        const id = `${String(r.sch)}.${String(r.tbl)}.${String(r.index_id)}`;
        if (id !== currentId) {
          currentId = id;
          current = { columns: [], unique: Boolean(r.is_unique) };
          t.indexes.push(current);
          if (r.is_primary_key) t.primaryKey = current.columns;
        }
        current!.columns.push(String(r.col));
      }
      return [...tables.values()];
    },
    async countRows(t) {
      const rows = await query(`SELECT COUNT_BIG(*) AS n FROM ${name(t)}`);
      return Number(rows[0]?.n ?? 0);
    },
    async selectRows(t, columns, keys, limit): Promise<Row[]> {
      const info = await describeCached(t);
      const byName = new Map(info.meta.map((c) => [c.name, c]));
      const inputs: Input[] = [];
      const where = keyCondition(
        columns,
        keys,
        (c) => `${ALIAS}.${q(c)}`,
        (c, v) => {
          const { input, expr } = bind(byName.get(c), v, `p${inputs.length}`);
          inputs.push(input);
          return expr;
        },
      );
      const order = info.primaryKey.length ? ` ORDER BY ${info.primaryKey.map((c) => `${ALIAS}.${q(c)}`).join(", ")}` : "";
      const exact = info.meta.filter((c) => c.base === "bigint" || wide(c)).map((c) => c.name);
      const dates = info.meta.filter((c) => DATE_TYPES.has(c.base)).map((c) => c.name);
      const rows = await query(
        `SELECT TOP (${Math.max(0, Math.floor(limit))}) ${selectList(info.meta)} FROM ${name(t)} AS ${ALIAS} WHERE ${where}${order}`,
        inputs,
      );
      return rows.map((r) => {
        const row = normalizeRow(r);
        for (const c of exact) row[c] = exactDecimal(row[c]);
        // 2026-10-01 10:02:11.000 → 2026-10-01 10:02:11 (the zeros say nothing)
        for (const c of dates) if (typeof row[c] === "string") row[c] = (row[c] as string).replace(/\.0+(?= |$)/, "");
        return row;
      });
    },
    async close() {
      await pool.close();
    },
  };
}

/** varchar(10), nvarchar(max), decimal(10,2), datetime2(3)… from sys.columns. max_length is in bytes. */
function typeText(base: string, maxLength: number, precision: number, scale: number): string {
  if (/^(var)?(char|binary)$/.test(base)) return `${base}(${maxLength === -1 ? "max" : maxLength})`;
  if (/^n(var)?char$/.test(base)) return `${base}(${maxLength === -1 ? "max" : maxLength / 2})`;
  if (/^(decimal|numeric)$/.test(base)) return `${base}(${precision},${scale})`;
  if (/^(datetime2|time|datetimeoffset)$/.test(base)) return `${base}(${scale})`;
  return base;
}

/** A number without exponent notation, which SQL Server can't convert to decimal. */
function plainNumber(n: number): string {
  const s = String(n);
  return /e/i.test(s) ? n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : s;
}

const nonEmpty = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
