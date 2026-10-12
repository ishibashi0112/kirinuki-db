import { existsSync, readFileSync } from "node:fs";
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
      "  orders 1行 → order_items 2行 → customers 1行 → items 2行 → stock 3行 → categories 2行 → warehouses 2行",
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

  it("shows how to use it", async () => {
    expect((await run([]))[0]).toContain("使い方:");
    await expect(run(["orders"])).rejects.toThrow("キーの値で指定してください");
    await expect(run(["orders", "1042", "--db", "mysql://localhost/x"])).rejects.toThrow("対応していない接続URLです: mysql:");
  });
});
