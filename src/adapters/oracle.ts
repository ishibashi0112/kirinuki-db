import { exactDecimal, normalizeRow } from "../core/normalize.js";
import type { ForeignKey, JsonValue, Row, TableInfo, TableRef } from "../core/types.js";
import { loadDriver } from "./load.js";
import { databaseName, keyCondition } from "./sql.js";
import type { DbAdapter } from "./types.js";

type OracleDb = typeof import("oracledb");

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const ALIAS = "k";

interface ColumnMeta {
  name: string;
  /** DATA_TYPE: VARCHAR2, NUMBER, TIMESTAMP(6)… */
  base: string;
  /** VARCHAR2(10 CHAR), NUMBER(10,2)… */
  type: string;
  nullable: boolean;
  comment?: string;
}

/** Number columns come as text (the driver's float would round large IDs and long decimals). (From ashiato.) */
function fetchTypeHandler(oracledb: OracleDb) {
  return (meta: import("oracledb").Metadata<unknown>) => {
    switch (meta.dbType) {
      case oracledb.DB_TYPE_NUMBER:
        return { type: oracledb.STRING, converter: exactDecimal as (v: unknown) => unknown };
      case oracledb.DB_TYPE_CLOB:
      case oracledb.DB_TYPE_NCLOB:
        return { type: oracledb.STRING };
      case oracledb.DB_TYPE_BLOB:
        return { type: oracledb.BUFFER };
      default:
        return undefined;
    }
  };
}

/**
 * oracle://user:password@host:1521/serviceName?schema=OWNER — node-oracledb Thin mode (no Instant
 * Client needed; Oracle Database 12.1 or later). Connection code from ashiato.
 */
export async function connectOracle(url: URL): Promise<DbAdapter> {
  const oracledb = await loadDriver<OracleDb>("oracledb", "Oracle");
  const pool = await oracledb.createPool({
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectString: `${url.hostname}:${url.port || 1521}${decodeURIComponent(url.pathname)}`,
    poolMin: 0,
    poolMax: 1,
    poolPingInterval: 10,
  });
  const handler = fetchTypeHandler(oracledb);
  const exec = async (sql: string, binds: Record<string, unknown> = {}) => {
    const conn = await pool.getConnection();
    try {
      const res = await conn.execute(sql, binds as import("oracledb").BindParameters, { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler: handler });
      return (res.rows ?? []) as Record<string, unknown>[];
    } finally {
      await conn.close();
    }
  };

  const owner =
    url.searchParams.get("schema")?.toUpperCase() ??
    String((await exec("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS S FROM DUAL"))[0]?.S);
  const name = (t: TableRef) => `${q(t.schema ?? owner)}.${q(t.name)}`;

  const describe = async (t: TableRef): Promise<TableInfo & { meta: ColumnMeta[] }> => {
    const binds = { owner: t.schema ?? owner, tbl: t.name };
    const cols = await exec(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.CHAR_LENGTH, c.CHAR_USED, c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE, m.COMMENTS
         FROM ALL_TAB_COLUMNS c
         LEFT JOIN ALL_COL_COMMENTS m ON m.OWNER = c.OWNER AND m.TABLE_NAME = c.TABLE_NAME AND m.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.OWNER = :owner AND c.TABLE_NAME = :tbl AND c.COLUMN_ID IS NOT NULL
        ORDER BY c.COLUMN_ID`,
      binds,
    );
    if (cols.length === 0) throw new Error(`Table not found: ${name(t)}`);
    const key = await exec(
      `SELECT cc.COLUMN_NAME FROM ALL_CONSTRAINTS c
         JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
        WHERE c.CONSTRAINT_TYPE = 'P' AND c.OWNER = :owner AND c.TABLE_NAME = :tbl
        ORDER BY cc.POSITION`,
      binds,
    );
    const comment = await exec(`SELECT COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = :owner AND TABLE_NAME = :tbl`, binds);
    const meta = cols.map((c) => ({
      name: String(c.COLUMN_NAME),
      base: String(c.DATA_TYPE),
      type: typeText(c),
      nullable: c.NULLABLE === "Y",
      comment: nonEmpty(c.COMMENTS),
    }));
    return {
      table: { schema: t.schema ?? owner, name: t.name },
      columns: meta.map(({ name, type, nullable, comment }) => ({ name, type, nullable, comment })),
      primaryKey: key.map((k) => String(k.COLUMN_NAME)),
      comment: nonEmpty(comment[0]?.COMMENTS),
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

  // The driver turns DATE / TIMESTAMP into a JavaScript Date: milliseconds only, and shifted around
  // daylight saving changes. Such columns are read as text formatted by the database instead.
  const format = (base: string) => {
    if (base === "DATE") return { text: "YYYY-MM-DD HH24:MI:SS" };
    const m = /^TIMESTAMP\((\d)\)( WITH (LOCAL )?TIME ZONE)?$/.exec(base);
    if (!m) return undefined;
    return { text: `YYYY-MM-DD HH24:MI:SS${m[1] === "0" ? "" : `.FF${m[1]}`}${m[2] ? " TZH:TZM" : ""}`, utc: Boolean(m[3]), zone: Boolean(m[2]) };
  };
  const selectList = (meta: ColumnMeta[]) =>
    meta
      .map((c) => {
        const col = `${ALIAS}.${q(c.name)}`;
        const f = format(c.base);
        return f ? `TO_CHAR(${f.utc ? `${col} AT TIME ZONE '+00:00'` : col}, '${f.text}') AS ${q(c.name)}` : col;
      })
      .join(", ");

  /** A key value as a bind the database converts to the column's type (so the column's index is used). */
  const bind = (c: ColumnMeta | undefined, value: JsonValue): { value: unknown; expr: (p: string) => string } => {
    const base = c?.base ?? "";
    const s = String(value);
    const f = format(base);
    if (f && !f.zone) return { value: s, expr: (p) => `${base === "DATE" ? "TO_DATE" : "TO_TIMESTAMP"}(${p}, '${f.text}')` };
    // CHAR columns compare blank-padded only with another CHAR: a value typed without the trailing spaces still matches
    if (base === "CHAR" || base === "NCHAR") return { value: s, expr: (p) => `CAST(${p} AS ${c!.type})` };
    if (base === "RAW" && s.startsWith("0x")) return { value: s.slice(2), expr: (p) => `HEXTORAW(${p})` };
    if (typeof value === "number" && /^(NUMBER|FLOAT|BINARY_)/.test(base)) return { value, expr: (p) => p };
    return { value: typeof value === "boolean" ? (value ? 1 : 0) : s, expr: (p) => p };
  };

  return {
    dialect: "oracle",
    label: `Oracle: ${databaseName(url)} (${owner})`,
    defaultSchema: owner,
    async listTables() {
      // IOT overflow segments are listed too but can't be queried (ORA-25191). (From ashiato.)
      const rows = await exec(
        `SELECT OWNER, TABLE_NAME FROM ALL_TABLES
          WHERE OWNER = :owner AND NESTED = 'NO' AND SECONDARY = 'N' AND (IOT_TYPE IS NULL OR IOT_TYPE = 'IOT')
          ORDER BY TABLE_NAME`,
        { owner },
      );
      return rows.map((r) => ({ schema: String(r.OWNER), name: String(r.TABLE_NAME) }));
    },
    async describeTable(t) {
      const { meta: _meta, ...info } = await describeCached(t);
      return info;
    },
    async foreignKeys() {
      // the referenced columns are those of the parent's primary / unique key, matched by position
      const rows = await exec(
        `SELECT c.OWNER, c.CONSTRAINT_NAME, c.TABLE_NAME, cc.COLUMN_NAME, r.OWNER AS R_OWNER, r.TABLE_NAME AS R_TABLE, rc.COLUMN_NAME AS R_COLUMN
           FROM ALL_CONSTRAINTS c
           JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
           JOIN ALL_CONSTRAINTS r ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
           JOIN ALL_CONS_COLUMNS rc ON rc.OWNER = r.OWNER AND rc.CONSTRAINT_NAME = r.CONSTRAINT_NAME AND rc.POSITION = cc.POSITION
          WHERE c.CONSTRAINT_TYPE = 'R' AND (c.OWNER = :owner OR c.R_OWNER = :owner)
          ORDER BY c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION`,
        { owner },
      );
      const byName = new Map<string, ForeignKey>();
      for (const r of rows) {
        const id = `${String(r.OWNER)}.${String(r.CONSTRAINT_NAME)}`;
        let fk = byName.get(id);
        if (!fk) {
          fk = {
            name: String(r.CONSTRAINT_NAME),
            from: { schema: String(r.OWNER), name: String(r.TABLE_NAME) },
            columns: [],
            to: { schema: String(r.R_OWNER), name: String(r.R_TABLE) },
            refColumns: [],
          };
          byName.set(id, fk);
        }
        fk.columns.push(String(r.COLUMN_NAME));
        fk.refColumns.push(String(r.R_COLUMN));
      }
      return [...byName.values()];
    },
    async countRows(t) {
      return Number((await exec(`SELECT COUNT(*) AS N FROM ${name(t)}`))[0]?.N ?? 0);
    },
    async selectRows(t, columns, keys, limit): Promise<Row[]> {
      const info = await describeCached(t);
      const byName = new Map(info.meta.map((c) => [c.name, c]));
      const binds: Record<string, unknown> = {};
      const where = keyCondition(
        columns,
        keys,
        (c) => `${ALIAS}.${q(c)}`,
        (c, v) => {
          const p = `p${Object.keys(binds).length}`;
          const b = bind(byName.get(c), v);
          binds[p] = b.value;
          return b.expr(`:${p}`);
        },
      );
      const order = info.primaryKey.length ? ` ORDER BY ${info.primaryKey.map((c) => `${ALIAS}.${q(c)}`).join(", ")}` : "";
      // ROWNUM rather than FETCH FIRST, which needs 12c's newer syntax
      const sql = `SELECT * FROM (SELECT ${selectList(info.meta)} FROM ${name(t)} ${ALIAS} WHERE ${where}${order}) WHERE ROWNUM <= ${Math.max(0, Math.floor(limit))}`;
      return (await exec(sql, binds)).map(normalizeRow);
    },
    async close() {
      await pool.close(0);
    },
  };
}

/** VARCHAR2(10 CHAR), NUMBER(10,2), RAW(16)… from ALL_TAB_COLUMNS. */
function typeText(c: Record<string, unknown>): string {
  const t = String(c.DATA_TYPE);
  const p = c.DATA_PRECISION === null ? undefined : Number(c.DATA_PRECISION);
  const s = c.DATA_SCALE === null ? undefined : Number(c.DATA_SCALE);
  if (t === "VARCHAR2" || t === "CHAR") return c.CHAR_USED === "C" ? `${t}(${Number(c.CHAR_LENGTH)} CHAR)` : `${t}(${Number(c.DATA_LENGTH)})`;
  if (t === "NVARCHAR2" || t === "NCHAR") return `${t}(${Number(c.CHAR_LENGTH)})`;
  if (t === "RAW") return `RAW(${Number(c.DATA_LENGTH)})`;
  if (t === "FLOAT") return p === undefined ? t : `FLOAT(${p})`;
  if (t === "NUMBER") {
    if (p === undefined) return s === 0 ? "NUMBER(*,0)" : "NUMBER";
    return s ? `NUMBER(${p},${s})` : `NUMBER(${p})`;
  }
  return t;
}

const nonEmpty = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
