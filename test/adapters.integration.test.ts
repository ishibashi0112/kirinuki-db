/**
 * Runs the sales scenario against real database servers. Each dialect runs only when its URL is set:
 *   KIRINUKI_TEST_POSTGRES_URL, KIRINUKI_TEST_MSSQL_URL, KIRINUKI_TEST_ORACLE_URL
 * CI starts these servers as service containers.
 *
 * The URL's user creates the tables. kirinuki connects as a separate user that was only granted
 * SELECT, exactly like in real use, so the catalog queries (keys, foreign keys, comments) must work
 * for such a user. Oracle needs KIRINUKI_TEST_ORACLE_ADMIN_URL (a user that can create users) for that.
 */
import { describe, expect, it } from "vitest";
import { connect } from "../src/adapters/index.js";
import { loadDriver } from "../src/adapters/load.js";
import type { Row } from "../src/core/types.js";
import { packWorkbook } from "../src/export/workbook.js";
import { collectPack } from "../src/pack/collect.js";
import { type Dialect, salesComments, salesSchema, TABLES } from "./fixtures/sales.js";
import { picture, readWorkbook } from "./helpers.js";

interface Writer {
  run: (sql: string) => Promise<void>;
  close: () => Promise<void>;
  /** Creates a user that may only SELECT from these tables and returns a URL that connects as it. */
  readOnlyUrl: (tables: string[]) => Promise<string>;
}

const RO = "kirinuki_ro";

const withUser = (url: string, user: string, password: string, params: Record<string, string> = {}) => {
  const u = new URL(url);
  u.username = user;
  u.password = encodeURIComponent(password);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

const writers: Record<Exclude<Dialect, "sqlite">, (url: string) => Promise<Writer>> = {
  async postgres(url) {
    const pg = await loadDriver<typeof import("pg")>("pg", "PostgreSQL");
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const run = async (sql: string) => void (await c.query(sql));
    return {
      run,
      close: () => c.end(),
      async readOnlyUrl(tables) {
        await run(`DO $$ BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${RO}') THEN EXECUTE 'DROP OWNED BY ${RO}'; EXECUTE 'DROP ROLE ${RO}'; END IF;
        END $$`);
        await run(`CREATE ROLE ${RO} LOGIN PASSWORD '${RO}'`);
        await run(`GRANT USAGE ON SCHEMA public TO ${RO}`);
        await run(`GRANT SELECT ON ${tables.join(", ")} TO ${RO}`);
        return withUser(url, RO, RO);
      },
    };
  },
  async mssql(url) {
    const mssql = await loadDriver<typeof import("mssql")>("mssql", "SQL Server");
    const u = new URL(url);
    const open = (database: string) =>
      new mssql.ConnectionPool({
        server: u.hostname,
        port: Number(u.port || 1433),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database,
        options: { encrypt: false, trustServerCertificate: true },
      }).connect();
    // a database of its own, so that the read-only user sees only these tables
    const master = await open(u.pathname.slice(1) || "master");
    await master.request().batch(`IF DB_ID('kirinuki_test') IS NULL CREATE DATABASE kirinuki_test`);
    await master.close();
    const pool = await open("kirinuki_test");
    const run = async (sql: string) => void (await pool.request().batch(sql));
    const password = "Kirinuki#ro2026";
    return {
      run,
      close: () => pool.close(),
      async readOnlyUrl(tables) {
        await run(`IF USER_ID('${RO}') IS NOT NULL DROP USER ${RO}`);
        await run(`IF SUSER_ID('${RO}') IS NOT NULL DROP LOGIN ${RO}`);
        await run(`CREATE LOGIN ${RO} WITH PASSWORD = '${password}', CHECK_POLICY = OFF`);
        await run(`CREATE USER ${RO} FOR LOGIN ${RO}`);
        for (const t of tables) await run(`GRANT SELECT ON ${t} TO ${RO}`);
        const ro = new URL(withUser(url, RO, password));
        ro.pathname = "/kirinuki_test";
        return ro.toString();
      },
    };
  },
  async oracle(url) {
    const oracledb = await loadDriver<typeof import("oracledb")>("oracledb", "Oracle");
    const open = async (connUrl: string) => {
      const u = new URL(connUrl);
      return oracledb.getConnection({
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        connectString: `${u.hostname}:${u.port || 1521}${u.pathname}`,
      });
    };
    const c = await open(url);
    const run = async (sql: string) => void (await c.execute(sql, [], { autoCommit: true }));
    const owner = decodeURIComponent(new URL(url).username).toUpperCase();
    return {
      run,
      close: () => c.close(),
      async readOnlyUrl(tables) {
        const adminUrl = process.env.KIRINUKI_TEST_ORACLE_ADMIN_URL;
        if (!adminUrl) return url;
        const admin = await open(adminUrl);
        try {
          await admin.execute(`BEGIN EXECUTE IMMEDIATE 'DROP USER ${RO} CASCADE'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
          await admin.execute(`CREATE USER ${RO} IDENTIFIED BY ${RO}`);
          await admin.execute(`GRANT CREATE SESSION TO ${RO}`);
        } finally {
          await admin.close();
        }
        for (const t of tables) await run(`GRANT SELECT ON ${t} TO ${RO}`);
        return withUser(url, RO, RO, { schema: owner });
      },
    };
  },
};

/** Column types as each database writes them. */
const TYPES: Record<Exclude<Dialect, "sqlite">, Record<string, string>> = {
  postgres: { order_no: "character varying(12)", status: "character(2)", ordered_at: "timestamp(0) without time zone" },
  mssql: { order_no: "varchar(12)", status: "char(2)", ordered_at: "datetime2(0)" },
  oracle: { order_no: "VARCHAR2(12)", status: "CHAR(2)", ordered_at: "DATE" },
};

const lower = (r: Row | undefined) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k.toLowerCase(), typeof v === "string" ? v.trimEnd() : v]));
/** Key values without the padding of CHAR columns. */
const trimmed = (p: Record<string, string[]>) => Object.fromEntries(Object.entries(p).map(([t, keys]) => [t, keys.map((k) => k.replace(/ +(?=\/|$)/g, ""))]));

for (const [dialect, writer] of Object.entries(writers) as [Exclude<Dialect, "sqlite">, (url: string) => Promise<Writer>][]) {
  const url = process.env[`KIRINUKI_TEST_${dialect.toUpperCase()}_URL`];
  describe.skipIf(!url)(`${dialect} adapter`, () => {
    it("cuts out an order as a SELECT-only user", { timeout: 120_000 }, async () => {
      const w = await writer(url!);
      try {
        for (const t of TABLES) await w.run(`DROP TABLE ${t}`).catch(() => undefined);
        for (const sql of [...salesSchema(dialect), ...salesComments(dialect)]) await w.run(sql);
        const db = await connect(await w.readOnlyUrl(TABLES));
        try {
          const pack = await collectPack(db, { table: "orders", values: ["1042"] });
          expect(trimmed(picture(pack))).toEqual({
            orders: ["1042"],
            order_items: ["1042/1", "1042/2"],
            customers: ["7"],
            items: ["A-100", "B-210"],
            stock: ["A-100/10", "A-100/20", "B-210/10"],
            categories: ["1", "2"],
            warehouses: ["10", "20"],
          });
          expect(pack.unfollowed.filter((l) => l.reason === "not-detail").map((l) => l.fk.from.name.toLowerCase()).sort()).toEqual(["categories", "shipments"]);
          expect(pack.tables.map((t) => t.totalRows)).toEqual([3, 5, 2, 3, 4, 3, 2]);

          const orders = pack.tables[0]!;
          expect(lower(orders.rows[0])).toEqual({ order_id: 1042, order_no: "S-1042", customer_id: 7, status: "02", order_kbn: "1", ordered_at: "2026-10-01 10:02:11" });
          expect(orders.info.comment).toBe("受注ヘッダー。1注文=1行");
          const column = (name: string) => orders.info.columns.find((c) => c.name.toLowerCase() === name)!;
          expect(column("status").comment).toBe("注文の状態");
          for (const [name, type] of Object.entries(TYPES[dialect])) expect(column(name).type, name).toBe(type);
          expect(orders.info.primaryKey.map((c) => c.toLowerCase())).toEqual(["order_id"]);
          expect(lower(pack.tables.find((t) => /^items$/i.test(t.info.table.name))?.rows[0])).toEqual({
            item_cd: "A-100",
            item_name: "ボールベアリング 6202",
            unit_price: 480,
            category_id: 2,
          });

          const book = readWorkbook(await packWorkbook(pack));
          expect(book.get("テーブル説明")?.[1]?.slice(0, 4)).toEqual([orders.info.table.name, "受注ヘッダー。1注文=1行", 1, 3]);
          // without the padding of the CHAR(3) column
          expect([...book].find(([name]) => /^warehouses$/i.test(name))?.[1].slice(1)).toEqual([
            ["10", "本社倉庫"],
            ["20", "大阪倉庫"],
          ]);

          // start values bound against other column types: a composite key, text, a date, a decimal, a padded CHAR
          expect(trimmed(picture(await collectPack(db, { table: "order_items", values: ["1042", "2"] })))).toEqual({
            order_items: ["1042/2"],
            orders: ["1042"],
            items: ["B-210"],
            customers: ["7"],
            stock: ["B-210/10"],
            categories: ["1"],
            warehouses: ["10"],
          });
          expect(picture(await collectPack(db, { table: "orders", values: ["S-1044"], by: ["order_no"], parentsOnly: true })).orders).toEqual(["1044"]);
          expect(picture(await collectPack(db, { table: "orders", values: ["2026-10-01 11:15:40"], by: ["ordered_at"], parentsOnly: true })).orders).toEqual(["1043"]);
          expect(picture(await collectPack(db, { table: "items", values: ["320"], by: ["unit_price"], parentsOnly: true })).items).toEqual(["B-210"]);
          expect(trimmed(picture(await collectPack(db, { table: "warehouses", values: ["20"] })))).toEqual({
            warehouses: ["20"],
            stock: ["A-100/20"],
            items: ["A-100"],
            categories: ["1", "2"],
          });
        } finally {
          await db.close();
        }
      } finally {
        for (const t of TABLES) await w.run(`DROP TABLE ${t}`).catch(() => undefined);
        await w.close();
      }
    });
  });
}
