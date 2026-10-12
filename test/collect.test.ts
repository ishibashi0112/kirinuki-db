import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type DbAdapter } from "../src/adapters/index.js";
import { collectPack, type Pack, resolveTable } from "../src/pack/collect.js";
import { createSalesDb, picture } from "./helpers.js";

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
      categories: ["1", "2"],
      warehouses: ["10", "20"],
    });
    // in the order reached: the start, its details, its parents...
    expect(Object.keys(picture(pack))).toEqual(["orders", "order_items", "customers", "items", "stock", "categories", "warehouses"]);
    expect(links(pack)).toEqual({
      followed: [
        "categories.parent_id parent 1",
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
      "parent:items",
      "parent:stock",
    ]);
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
