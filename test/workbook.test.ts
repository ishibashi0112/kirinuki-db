import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type DbAdapter } from "../src/adapters/index.js";
import { packWorkbook } from "../src/export/workbook.js";
import { collectPack } from "../src/pack/collect.js";
import { createSalesDb, readWorkbook, unzip } from "./helpers.js";

let db: DbAdapter;
beforeAll(async () => {
  db = await connect(`sqlite:${createSalesDb()}`);
});
afterAll(() => db.close());

const now = new Date(2026, 9, 12, 16, 50);

describe("packWorkbook", () => {
  it("writes the front sheet, the table and column descriptions, then one sheet per table", async () => {
    const pack = await collectPack(db, { table: "orders", values: ["1042"], now });
    const book = readWorkbook(await packWorkbook(pack));
    expect([...book.keys()]).toEqual(["はじめに", "テーブル説明", "列説明", "orders", "order_items", "customers", "items", "stock", "categories", "warehouses"]);

    const front = book.get("はじめに")!;
    expect(front[0]).toEqual(["項目", "内容"]);
    expect(front[1]).toEqual(["このファイルは", "社内DB(SQLite: sales.db)から、orders.order_id = 1042 に関係する行だけを抜き出したものです"]);
    expect(front[2]).toEqual(["起点", "orders.order_id = 1042"]);
    expect(front[3]).toEqual(["抜き出し日時", "2026-10-12 16:50"]);
    const lines = (label: string) => {
      const from = front.findIndex((r) => r[0] === label);
      const to = front.findIndex((r, i) => i > from && r[0] !== null);
      return front.slice(from, to < 0 ? undefined : to).map((r) => r[1]);
    };
    expect(lines("たどった関係")).toEqual([
      "orders → order_items(明細:order_items.order_id = orders.order_id):2行",
      "orders → customers(参照先:orders.customer_id = customers.customer_id):1行",
      "order_items → items(参照先:order_items.item_cd = items.item_cd):2行",
      "items → stock(明細:stock.item_cd = items.item_cd):3行",
      "items → categories(参照先:items.category_id = categories.category_id):2行",
      "stock → warehouses(参照先:stock.wh_cd = warehouses.wh_cd):2行",
      "categories → categories(参照先:categories.parent_id = categories.category_id):1行",
    ]);
    expect(lines("たどり方")[0]).toContain("明細(主キーに親のキーを含むもの)だけをたどりました。1テーブルあたり最大1000行です。");
    expect(lines("入っていないもの")).toEqual([
      "同じ customers を参照している、ほかの orders の行(起点に関係しないもの)",
      "同じ items を参照している、ほかの order_items の行(起点に関係しないもの)",
      "同じ categories を参照している、ほかの items の行(起点に関係しないもの)",
      "同じ warehouses を参照している、ほかの stock の行(起点に関係しないもの)",
      "orders を参照している子テーブル shipments の行(たどっていません)",
      "categories を参照している子テーブル categories の行(たどっていません)",
      "外部キーが宣言されていない関係でつながる行(列名や値が似ていても、たどっていません)",
    ]);
    expect(lines("読み方")).toHaveLength(2);

    expect(book.get("テーブル説明")).toEqual([
      ["テーブル", "意味", "抜き出した行数", "元の行数", "入った経路"],
      ["orders", null, 1, 3, "起点"],
      ["order_items", null, 2, 5, "orders の明細"],
      ["customers", null, 1, 2, "orders の参照先"],
      ["items", null, 2, 3, "order_items の参照先"],
      ["stock", null, 3, 4, "items の明細"],
      ["categories", null, 2, 3, "items の参照先"],
      ["warehouses", null, 2, 2, "stock の参照先"],
    ]);

    const columns = book.get("列説明")!;
    expect(columns[0]).toEqual(["テーブル", "列", "型", "キー", "意味", "値の意味・参照先"]);
    expect(columns).toContainEqual(["orders", "customer_id", "INTEGER", null, null, "→ customers.customer_id"]);
    expect(columns).toContainEqual(["order_items", "order_id", "INTEGER", "主キー(1/2)", null, "→ orders.order_id"]);
    expect(columns).toContainEqual(["orders", "order_id", "INTEGER", "主キー", null, null]);
    expect(columns).toHaveLength(1 + 6 + 4 + 3 + 4 + 3 + 3 + 2);

    expect(book.get("orders")).toEqual([
      ["order_id", "order_no", "customer_id", "status", "order_kbn", "ordered_at"],
      [1042, "S-1042", 7, "02", "1", "2026-10-01 10:02:11"],
    ]);
    expect(book.get("stock")).toEqual([
      ["item_cd", "wh_cd", "qty"],
      ["A-100", "10", 40],
      ["A-100", "20", 12],
      ["B-210", "10", 3],
    ]);
  });

  it("says when only parents were followed", async () => {
    const pack = await collectPack(db, { table: "orders", values: ["1043"], parentsOnly: true, now });
    const front = readWorkbook(await packWorkbook(pack)).get("はじめに")!.map((r) => r[1]);
    expect(front).toContain("宣言されている外部キーだけをたどりました。参照先(マスタなど)はすべてたどり、参照元の子テーブルはたどっていません。1テーブルあたり最大1000行です。");
    expect(front).toContain("orders を参照している子テーブル order_items、shipments の行(たどっていません)");
  });

  it("links each table to its sheet and keeps the header in view", async () => {
    const pack = await collectPack(db, { table: "orders", values: ["1042"], now });
    const files = unzip(await packWorkbook(pack));
    const tables = files.get("xl/worksheets/sheet2.xml")!.toString("utf8");
    expect(tables).toContain(`<hyperlink ref="A2" location="'orders'!A1"/>`);
    expect(files.get("xl/worksheets/sheet4.xml")!.toString("utf8")).toContain(`state="frozen"`);
  });

  it("tells what was cut off, skipped or asked for", async () => {
    const pack = await collectPack(db, { table: "items", values: ["A-100"], children: ["order_items"], skip: ["warehouses"], maxRows: 1, now });
    const front = readWorkbook(await packWorkbook(pack)).get("はじめに")!.map((r) => r[1]);
    expect(front).toContain("items → order_items(子:order_items.item_cd = items.item_cd):1行");
    expect(front).toContain("warehouses の行(入れないよう指定されました)");
    expect(front).toContain("order_items の1行目より後の行(関係する行が1行を超えたため打ち切りました)");
    expect(front.find((l) => String(l).startsWith("宣言されている外部キーだけ"))).toContain("と指定されたものだけをたどりました。1テーブルあたり最大1行です。");
    const tables = readWorkbook(await packWorkbook(pack)).get("テーブル説明")!;
    expect(tables[2]).toEqual(["order_items", null, "1(上限で打ち切り)", 5, "items の子"]);
  });
});
