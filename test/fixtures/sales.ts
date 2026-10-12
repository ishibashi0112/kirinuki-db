/**
 * A small sales database shaped like docs/sample-pack.xlsx (fictional data), written for each dialect.
 *
 *   categories ← categories.parent_id (a tree)
 *   customers ← orders → order_items (order_id, line_no) → items → categories
 *                      ← shipments (not a detail: its key is ship_id)
 *   items ← stock (item_cd, wh_cd) → warehouses (wh_cd is CHAR(3) holding two characters: padded on most databases)
 */
export type Dialect = "sqlite" | "postgres" | "mssql" | "oracle";

const TYPES: Record<Dialect, Record<"int" | "code" | "text" | "money" | "time", (n?: number) => string>> = {
  sqlite: { int: () => "INTEGER", code: () => "TEXT", text: () => "TEXT", money: () => "NUMERIC", time: () => "TEXT" },
  postgres: { int: () => "integer", code: (n) => `varchar(${n})`, text: (n) => `varchar(${n})`, money: () => "numeric(10,0)", time: () => "timestamp(0)" },
  mssql: { int: () => "int", code: (n) => `varchar(${n})`, text: (n) => `nvarchar(${n})`, money: () => "decimal(10,0)", time: () => "datetime2(0)" },
  oracle: { int: () => "NUMBER(10)", code: (n) => `VARCHAR2(${n})`, text: (n) => `NVARCHAR2(${n})`, money: () => "NUMBER(10)", time: () => "DATE" },
};

export const TABLES = ["shipments", "stock", "order_items", "orders", "warehouses", "items", "customers", "categories"];

export function salesSchema(d: Dialect): string[] {
  const t = TYPES[d];
  const time = (s: string) => (d === "oracle" ? `TO_DATE('${s}', 'YYYY-MM-DD HH24:MI:SS')` : `'${s}'`);
  const n = (s: string) => (d === "mssql" || d === "oracle" ? `N'${s}'` : `'${s}'`);
  const rows = (table: string, values: string[]) => values.map((v) => `INSERT INTO ${table} VALUES (${v})`);
  return [
    `CREATE TABLE categories (category_id ${t.int()} PRIMARY KEY, parent_id ${t.int()} REFERENCES categories (category_id), category_name ${t.text(50)})`,
    `CREATE TABLE customers (customer_id ${t.int()} PRIMARY KEY, name ${t.text(50)}, rank CHAR(1))`,
    `CREATE TABLE items (item_cd ${t.code(10)} PRIMARY KEY, item_name ${t.text(50)}, unit_price ${t.money()},
       category_id ${t.int()} REFERENCES categories (category_id))`,
    `CREATE TABLE warehouses (wh_cd CHAR(3) PRIMARY KEY, wh_name ${t.text(20)})`,
    `CREATE TABLE orders (order_id ${t.int()} PRIMARY KEY, order_no ${t.code(12)} NOT NULL, customer_id ${t.int()} REFERENCES customers (customer_id),
       status CHAR(2), order_kbn CHAR(1), ordered_at ${t.time()})`,
    `CREATE TABLE order_items (order_id ${t.int()} NOT NULL REFERENCES orders (order_id), line_no ${t.int()} NOT NULL,
       item_cd ${t.code(10)} REFERENCES items (item_cd), qty ${t.int()}, PRIMARY KEY (order_id, line_no))`,
    `CREATE TABLE stock (item_cd ${t.code(10)} NOT NULL REFERENCES items (item_cd), wh_cd CHAR(3) NOT NULL REFERENCES warehouses (wh_cd),
       qty ${t.int()}, PRIMARY KEY (item_cd, wh_cd))`,
    `CREATE TABLE shipments (ship_id ${t.int()} PRIMARY KEY, order_id ${t.int()} REFERENCES orders (order_id), shipped_at ${t.time()})`,
    ...rows("categories", [`1, NULL, ${n("機械部品")}`, `2, 1, ${n("ベアリング")}`, `3, NULL, ${n("販促物")}`]),
    ...rows("customers", [`7, ${n("得意先_0001")}, 'A'`, `12, ${n("得意先_0002")}, 'B'`]),
    ...rows("items", [
      `'A-100', ${n("ボールベアリング 6202")}, 480, 2`,
      `'B-210', ${n("オイルシール 30x45")}, 320, 1`,
      `'C-001', ${n("カタログ(サンプル)")}, 0, 3`,
    ]),
    ...rows("warehouses", [`'10', ${n("本社倉庫")}`, `'20', ${n("大阪倉庫")}`]),
    ...rows("orders", [
      `1042, 'S-1042', 7, '02', '1', ${time("2026-10-01 10:02:11")}`,
      `1043, 'S-1043', 12, '01', '1', ${time("2026-10-01 11:15:40")}`,
      `1044, 'S-1044', 7, '03', '1', ${time("2026-09-20 09:00:00")}`,
    ]),
    ...rows("order_items", [`1042, 1, 'A-100', 10`, `1042, 2, 'B-210', 3`, `1043, 1, 'A-100', 5`, `1043, 2, 'C-001', 1`, `1044, 1, 'B-210', 2`]),
    ...rows("stock", [`'A-100', '10', 40`, `'A-100', '20', 12`, `'B-210', '10', 3`, `'C-001', '10', 200`]),
    ...rows("shipments", [`501, 1044, ${time("2026-09-21 15:00:00")}`, `502, 1042, ${time("2026-10-02 08:30:00")}`]),
  ];
}

/** Descriptions stored in the database itself (SQLite has none). */
export function salesComments(d: Dialect): string[] {
  switch (d) {
    case "sqlite":
      return [];
    case "postgres":
    case "oracle":
      return [`COMMENT ON TABLE orders IS '受注ヘッダー。1注文=1行'`, `COMMENT ON COLUMN orders.status IS '注文の状態'`];
    case "mssql":
      return [
        `EXEC sp_addextendedproperty 'MS_Description', N'受注ヘッダー。1注文=1行', 'SCHEMA', 'dbo', 'TABLE', 'orders'`,
        `EXEC sp_addextendedproperty 'MS_Description', N'注文の状態', 'SCHEMA', 'dbo', 'TABLE', 'orders', 'COLUMN', 'status'`,
      ];
  }
}
