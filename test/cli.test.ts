import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { createSalesDb, readWorkbook, tempDir } from "./helpers.js";

const run = async (args: string[]) => {
  const lines: string[] = [];
  await main(args, (l) => lines.push(l));
  return lines;
};

describe("kirinuki", () => {
  it("writes the pack and tells what it took", async () => {
    const out = join(tempDir(), "1042.xlsx");
    const lines = await run(["orders", "1042", "--db", `sqlite:${createSalesDb()}`, "--out", out]);
    expect(lines).toEqual([
      "接続しました(SQLite: sales.db)",
      "  orders 1行 → order_items 2行 → customers 1行 → items 2行 → stock 3行 → item_prices 3行 → categories 2行 → warehouses 2行",
      "  たどった関係のうち1つは列名からの推測です(kirinuki relations で一覧を確かめられます)",
      "  たどらなかった子テーブル: shipments, categories(入れるなら --children shipments のように指定)",
      expect.stringMatching(/^→ .*1042\.xlsx を書き出しました\(\d+KB\)$/),
    ]);
    expect(readWorkbook(readFileSync(out)).get("orders")?.[1]?.[0]).toBe(1042);
  });

  it("takes the connection from the environment and names the file after the start row", async () => {
    const dir = tempDir();
    const cwd = process.cwd();
    process.env.KIRINUKI_DB_URL = `sqlite:${createSalesDb()}`;
    try {
      process.chdir(dir);
      const lines = await run(["order_items", "1042", "2", "--parents-only", "--max-rows", "5"]);
      expect(lines.at(-1)).toMatch(/^→ order_items-1042-2\.xlsx を書き出しました/);
      expect(existsSync(join(dir, "order_items-1042-2.xlsx"))).toBe(true);
    } finally {
      process.chdir(cwd);
      delete process.env.KIRINUKI_DB_URL;
    }
  });

  it("lists the relations as a relations file, and follows the one it is given", async () => {
    const file = createSalesDb({ foreignKeys: false });
    const lines = await run(["relations", "--db", `sqlite:${file}`, "--table", "items"]);
    expect(lines[0]).toBe("接続しました(SQLite: sales.db)");
    expect(lines[1]!.split("\n")).toEqual([
      "# kirinuki の関係ファイル。子テーブル(列) -> 親テーブル(列) を1行ずつ。先頭に ! を付けた行は、その関係を使いません",
      "",
      "# 主キーと同じ名前の列からの推測(索引あり = 子の列で引ける索引がある)",
      "items(category_id) -> categories(category_id)    # 索引なし",
      "item_prices(item_cd) -> items(item_cd)    # 索引あり",
      "order_items(item_cd) -> items(item_cd)    # 索引あり",
      "stock(item_cd) -> items(item_cd)    # 索引あり",
      "",
    ]);

    const relations = join(tempDir(), "relations.txt");
    await run(["relations", "--db", `sqlite:${file}`, "--out", relations]);
    const text = readFileSync(relations, "utf8");
    expect(text).toContain("orders(customer_id) -> customers(customer_id)    # 索引なし");
    expect(text).not.toContain("categories(parent_id)");
    writeFileSync(relations, `${text}\ncategories(parent_id) -> categories(category_id)\n! orders(customer_id) -> customers(customer_id)\n`);

    const out = join(tempDir(), "x.xlsx");
    const pack = await run(["orders", "1042", "--db", `sqlite:${file}`, "--relations", relations, "--out", out]);
    expect(pack[1]).toBe("  orders 1行 → order_items 2行 → items 2行 → item_prices 3行 → stock 3行 → categories 2行 → warehouses 2行");
    const front = readWorkbook(readFileSync(out)).get("はじめに")!.map((r) => r[1]);
    expect(front).toContain("categories → categories(参照先:categories.parent_id = categories.category_id、関係ファイル):1行");
  });

  it("shows how to use it", async () => {
    expect((await run([]))[0]).toContain("使い方:");
    await expect(run(["orders"])).rejects.toThrow("キーの値で指定してください");
    await expect(run(["orders", "1042", "--db", "mysql://localhost/x"])).rejects.toThrow("対応していない接続URLです: mysql:");
  });
});
