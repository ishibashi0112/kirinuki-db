import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type DbAdapter } from "../src/adapters/index.js";
import { collectPack, type Pack, resolveTable } from "../src/pack/collect.js";
import { createDb, createSalesDb, picture } from "./helpers.js";

let db: DbAdapter;
beforeAll(async () => {
  db = await connect(`sqlite:${createSalesDb()}`);
});
afterAll(() => db.close());

const links = (pack: Pack) => ({
  followed: pack.followed.map((l) => `${l.fk.from.name}.${l.fk.columns.join("+")} ${l.direction} ${l.rows}`).sort(),
  unfollowed: pack.unfollowed.map((l) => `${l.fk.from.name}.${l.fk.columns.join("+")} ${l.direction} ${l.reason}`).sort(),
});

describe("collectPack", () => {
  it("follows parents always, details and their parents, but not back down to other orders", async () => {
    const pack = await collectPack(db, { table: "orders", values: ["1042"] });
    expect(picture(pack)).toEqual({
      orders: ["1042"],
      order_items: ["1042/1", "1042/2"],
      customers: ["7"],
      items: ["A-100", "B-210"],
      stock: ["A-100/10", "A-100/20", "B-210/10"],
      // no primary key nor foreign key: keyed by its unique index, found by its column name
      item_prices: ["A-100/2026-04-01 00:00:00", "A-100/2026-10-01 00:00:00", "B-210/2026-04-01 00:00:00"],
      categories: ["1", "2"],
      warehouses: ["10", "20"],
    });
    // in the order reached: the start, its details, its parents...
    expect(Object.keys(picture(pack))).toEqual(["orders", "order_items", "customers", "items", "stock", "item_prices", "categories", "warehouses"]);
    expect(links(pack)).toEqual({
      followed: [
        "categories.parent_id parent 1",
        "item_prices.item_cd child 3",
        "items.category_id parent 2",
        "order_items.item_cd parent 2",
        "order_items.order_id child 2",
        "orders.customer_id parent 1",
        "stock.item_cd child 3",
        "stock.wh_cd parent 2",
      ],
      unfollowed: [
        // the sub-categories of a category: not a detail (parent_id is not part of the key)
        "categories.parent_id child not-detail",
        // the other items of the same category, other order lines of the same item, other orders of the same customer...
        "items.category_id child reverse",
        "order_items.item_cd child reverse",
        "orders.customer_id child reverse",
        "shipments.order_id child not-detail",
        "stock.wh_cd child reverse",
      ],
    });
    expect(pack.tables.map((t) => t.via && `${t.via.direction}:${t.via.fk.from.name}`)).toEqual([
      undefined,
      "child:order_items",
      "parent:orders",
      "parent:order_items",
      "child:stock",
      "child:item_prices",
      "parent:items",
      "parent:stock",
    ]);
    expect(pack.tables.find((t) => t.info.table.name === "item_prices")?.info).toMatchObject({ primaryKey: ["item_cd", "valid_from"], keyFromIndex: true });
    expect(pack.followed.find((l) => l.fk.from.name === "item_prices")?.fk.source).toBe("inferred");
    expect(pack.followed.find((l) => l.fk.from.name === "stock")?.fk.source).toBe("declared");
    expect(pack.tables.find((t) => t.info.table.name === "order_items")?.totalRows).toBe(5);
    expect(pack.tables.every((t) => !t.truncated)).toBe(true);
    expect(pack.start).toEqual({ table: { name: "orders" }, columns: ["order_id"], values: ["1042"] });
  });

  it("starts from an order line without pulling in the order's other lines", async () => {
    const pack = await collectPack(db, { table: "ORDER_ITEMS", values: ["1042", "2"] });
    expect(picture(pack)).toEqual({
      order_items: ["1042/2"],
      orders: ["1042"],
      items: ["B-210"],
      customers: ["7"],
      stock: ["B-210/10"],
      item_prices: ["B-210/2026-04-01 00:00:00"],
      categories: ["1"],
      warehouses: ["10"],
    });
    expect(links(pack).unfollowed).toContain("order_items.order_id child reverse");
  });

  it("follows the child tables it is asked to, and skips the tables it is told to", async () => {
    const pack = await collectPack(db, { table: "orders", values: ["1042"], children: ["shipments"], skip: ["Stock"] });
    expect(picture(pack)).toEqual({
      orders: ["1042"],
      order_items: ["1042/1", "1042/2"],
      shipments: ["502"],
      customers: ["7"],
      items: ["A-100", "B-210"],
      item_prices: ["A-100/2026-04-01 00:00:00", "A-100/2026-10-01 00:00:00", "B-210/2026-04-01 00:00:00"],
      categories: ["1", "2"],
    });
    expect(links(pack).unfollowed).toContain("stock.item_cd child skipped");
  });

  it("follows parents only when asked", async () => {
    const pack = await collectPack(db, { table: "orders", values: ["1043"], parentsOnly: true });
    expect(picture(pack)).toEqual({ orders: ["1043"], customers: ["12"] });
    expect(links(pack).unfollowed).toEqual(["order_items.order_id child parents-only", "orders.customer_id child reverse", "shipments.order_id child not-detail"]);
  });

  it("finds the start row by other columns", async () => {
    const pack = await collectPack(db, { table: "orders", values: ["S-1044"], by: ["ORDER_NO"] });
    expect(picture(pack).orders).toEqual(["1044"]);
    expect(picture(pack).order_items).toEqual(["1044/1"]);
    expect(pack.start.columns).toEqual(["order_no"]);
  });

  it("stops at the row limit and says so", async () => {
    const pack = await collectPack(db, { table: "items", values: ["A-100"], children: ["order_items"], maxRows: 1 });
    const lines = pack.tables.find((t) => t.info.table.name === "order_items")!;
    expect(lines.rows).toHaveLength(1);
    expect(lines.truncated).toBe(true);
    expect(pack.tables.find((t) => t.info.table.name === "items")!.truncated).toBe(false);
  });

  it("goes on without a table it may not read, and says so", async () => {
    const denied: DbAdapter = {
      ...db,
      selectRows: (t, ...rest) => (t.name === "warehouses" ? Promise.reject(new Error("SELECT permission was denied")) : db.selectRows(t, ...rest)),
    };
    const pack = await collectPack(denied, { table: "orders", values: ["1042"] });
    expect(Object.keys(picture(pack))).not.toContain("warehouses");
    expect(pack.unfollowed.find((l) => l.reason === "error")).toMatchObject({ fk: { to: { name: "warehouses" } }, error: "SELECT permission was denied" });
  });

  it("explains what is wrong with the start", async () => {
    await expect(collectPack(db, { table: "orders", values: ["9999"] })).rejects.toThrow("orders に order_id = 9999 の行がありません");
    await expect(collectPack(db, { table: "order", values: ["1"] })).rejects.toThrow("テーブル order が見つかりません");
    await expect(collectPack(db, { table: "order_items", values: ["1042"] })).rejects.toThrow("値を2個指定してください");
    await expect(collectPack(db, { table: "orders", values: ["1"], by: ["no_such"] })).rejects.toThrow("列 no_such がありません");
  });
});

describe("without foreign keys", () => {
  let plain: DbAdapter;
  beforeAll(async () => {
    plain = await connect(`sqlite:${createSalesDb({ foreignKeys: false })}`);
  });
  afterAll(() => plain.close());

  it("finds the relations by the names of the primary keys", async () => {
    const pack = await collectPack(plain, { table: "orders", values: ["1042"] });
    expect(picture(pack)).toEqual({
      orders: ["1042"],
      order_items: ["1042/1", "1042/2"],
      customers: ["7"],
      items: ["A-100", "B-210"],
      stock: ["A-100/10", "A-100/20", "B-210/10"],
      item_prices: ["A-100/2026-04-01 00:00:00", "A-100/2026-10-01 00:00:00", "B-210/2026-04-01 00:00:00"],
      categories: ["1", "2"],
      warehouses: ["10", "20"],
    });
    expect(pack.followed.every((l) => l.fk.source === "inferred")).toBe(true);
    expect(links(pack).unfollowed).toContain("shipments.order_id child not-detail");
    expect(pack.inferred).toBe(true);
  });

  it("follows nothing but the start without guessing", async () => {
    const pack = await collectPack(plain, { table: "orders", values: ["1042"], infer: false });
    expect(picture(pack)).toEqual({ orders: ["1042"] });
  });

  it("adds the relations of a relations file and leaves out the ones it removes", async () => {
    const text = ["# 分類の木", "CATEGORIES(Parent_ID) -> categories(category_id)", "", "! stock(wh_cd) → warehouses(wh_cd)  # 倉庫は要らない"].join("\n");
    const pack = await collectPack(plain, { table: "categories", values: ["2"], relations: { name: "relations.txt", text } });
    expect(picture(pack)).toEqual({ categories: ["1", "2"] });
    expect(pack.followed.map((l) => [l.fk.source, l.direction, l.fk.columns])).toEqual([["file", "parent", ["parent_id"]]]);
    expect(pack.relationsFile).toBe("relations.txt");

    const order = await collectPack(plain, { table: "orders", values: ["1042"], relations: { name: "relations.txt", text } });
    expect(Object.keys(picture(order))).not.toContain("warehouses");
  });

  it("points at the line of a relations file it can't read", async () => {
    const bad = (text: string) => collectPack(plain, { table: "orders", values: ["1042"], relations: { name: "r.txt", text } });
    await expect(bad("orders(customer_id) customers(customer_id)")).rejects.toThrow("r.txt 1行目: 「子テーブル(列) -> 親テーブル(列)」の形で書いてください");
    await expect(bad("\norders(customer) -> customers(customer_id)")).rejects.toThrow("r.txt 2行目: orders に列 customer がありません");
    await expect(bad("orders(customer_id) -> clients(customer_id)")).rejects.toThrow("r.txt 1行目: テーブル clients が見つかりません");
    await expect(bad("orders(customer_id, order_no) -> customers(customer_id)")).rejects.toThrow("子と親の列の数をそろえてください");
  });
});

describe("a company code leading every key", () => {
  // every key starts with company_cd, the key of companies: each table is a "detail" of the company
  const statements = [
    "CREATE TABLE companies (company_cd TEXT PRIMARY KEY, name TEXT)",
    "CREATE TABLE customers (company_cd TEXT, customer_cd TEXT, name TEXT, PRIMARY KEY (company_cd, customer_cd))",
    "CREATE TABLE customer_notes (company_cd TEXT, customer_cd TEXT, seq INTEGER, note TEXT, PRIMARY KEY (company_cd, customer_cd, seq))",
    "CREATE TABLE items (company_cd TEXT, item_cd TEXT, name TEXT, PRIMARY KEY (company_cd, item_cd))",
    "CREATE TABLE item_history (company_cd TEXT, item_cd TEXT, seq INTEGER, PRIMARY KEY (company_cd, item_cd, seq))",
    "CREATE TABLE orders (company_cd TEXT, order_no TEXT, customer_cd TEXT, PRIMARY KEY (company_cd, order_no))",
    "CREATE TABLE order_lines (company_cd TEXT, order_no TEXT, line_no INTEGER, item_cd TEXT, PRIMARY KEY (company_cd, order_no, line_no))",
    "INSERT INTO companies VALUES ('01', 'Kirinuki Co.')",
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) INSERT INTO customers SELECT '01', printf('C%03d', i), 'customer' FROM n",
    "INSERT INTO customer_notes VALUES ('01', 'C001', 1, 'a'), ('01', 'C001', 2, 'b'), ('01', 'C002', 1, 'c')",
    "INSERT INTO items VALUES ('01', 'A-100', 'bearing'), ('01', 'B-210', 'seal')",
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) INSERT INTO item_history SELECT '01', 'A-100', i FROM n",
    "INSERT INTO item_history VALUES ('01', 'B-210', 1)",
    "INSERT INTO orders VALUES ('01', '1042', 'C001'), ('01', '1043', 'C002')",
    "INSERT INTO order_lines VALUES ('01', '1042', 1, 'A-100'), ('01', '1042', 2, 'B-210'), ('01', '1043', 1, 'A-100')",
  ];

  it("does not bring in the company's other rows, nor a parent's long history", async () => {
    const tenant = await connect(`sqlite:${createDb(statements)}`);
    try {
      const pack = await collectPack(tenant, { table: "orders", values: ["01", "1042"] });
      expect(picture(pack)).toEqual({
        orders: ["01/1042"],
        order_lines: ["01/1042/1", "01/1042/2"],
        companies: ["01"],
        customers: ["01/C001"],
        customer_notes: ["01/C001/1", "01/C001/2"],
        items: ["01/A-100", "01/B-210"],
      });
      const unfollowed = links(pack).unfollowed;
      // reached from its orders, the company's other customers, items and order lines are someone else's
      expect(unfollowed).toEqual(expect.arrayContaining(["customers.company_cd child reverse", "items.company_cd child reverse", "order_lines.company_cd child reverse"]));
      // 151 rows of history for the items of this order: more than a detail of a parent may bring
      expect(unfollowed).toContain("item_history.company_cd+item_cd child too-many");
    } finally {
      await tenant.close();
    }
  });
});

describe("resolveTable", () => {
  const tables = [
    { schema: "dbo", name: "orders" },
    { schema: "archive", name: "orders" },
    { schema: "dbo", name: "Items" },
  ];
  it("prefers the default schema and accepts any letter case", () => {
    expect(resolveTable("orders", tables, "dbo")).toEqual({ schema: "dbo", name: "orders" });
    expect(resolveTable("ARCHIVE.Orders", tables, "dbo")).toEqual({ schema: "archive", name: "orders" });
    expect(resolveTable("items", tables, "dbo")).toEqual({ schema: "dbo", name: "Items" });
    expect(() => resolveTable("orders", tables, "sales")).toThrow("複数のスキーマにあります: dbo.orders, archive.orders");
    expect(() => resolveTable("stock", tables, "SALES", "oracle")).toThrow("?schema=所有者");
  });
});
