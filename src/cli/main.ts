import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { connect } from "../adapters/index.js";
import { packWorkbook } from "../export/workbook.js";
import { collectPack, DEFAULT_MAX_ROWS, type Pack, tableLabel } from "../pack/collect.js";

const HELP = `kirinuki — 社内DBから、ある件に関係する行だけを説明つきの Excel に切り抜きます

使い方:
  kirinuki <テーブル> <キーの値...> --db <接続URL> [オプション]

例:
  kirinuki orders 1042 --db "mssql://user:pass@dbserver/salesdb"
  kirinuki order_items 1042 1 --db ...            複合主キーは、値を主キーの順に
  kirinuki orders A-1042 --by order_no --db ...   主キー以外の列で探す

接続URL(--db、または環境変数 KIRINUKI_DB_URL)。参照権限(SELECT)だけで動きます:
  mssql://user:pass@host:1433/db       SQL Server(名前付きインスタンスは ?instance=SQLEXPRESS、
                                       Windows ログインは ?domain=ドメイン名)
  oracle://user:pass@host:1521/service Oracle(ほかのユーザーのテーブルは ?schema=所有者)
  postgres://user:pass@host:5432/db    PostgreSQL
  sqlite:./test.db                     SQLite
  パスワードの記号はパーセントエンコードしてください(@ → %40、# → %23、% → %25)

オプション:
  --by <列,...>          値を主キーではなくこの列で探す
  --children <表,...>    明細ではない子テーブルもたどる(出荷、請求など)
  --skip <表,...>        このテーブルには進まない
  --parents-only         子テーブルはたどらない(明細も。参照先だけ)
  --max-rows <n>         1テーブルから取る行の上限(既定 ${DEFAULT_MAX_ROWS})
  --out <file>           書き出すファイル(既定: <テーブル>-<値>.xlsx)

たどり方:
  参照先(外部キーで参照している行。注文 → 得意先、注文明細 → 商品)はいつもたどります。
  子テーブル(その行を参照している行)は、明細(主キーに親のキーを含むもの。注文 → 注文明細)だけです。
  たどってきた外部キーを逆には戻りません(商品から、同じ商品を使う他の注文明細へは進みません)。
`;

/** M365 Copilot's guideline for one attached file. */
const ATTACHMENT_LIMIT = 10 * 1024 * 1024;

const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

export async function main(argv: string[], print: (line: string) => void = console.log): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      by: { type: "string" },
      children: { type: "string" },
      skip: { type: "string" },
      "parents-only": { type: "boolean" },
      "max-rows": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [table, ...keyValues] = positionals;
  if (values.help || !table) {
    print(HELP);
    return;
  }
  if (keyValues.length === 0) throw new Error(`${table} のどの行かを、キーの値で指定してください(例: kirinuki ${table} 1042)`);
  const url = values.db ?? process.env.KIRINUKI_DB_URL;
  if (!url) throw new Error("接続先を --db か環境変数 KIRINUKI_DB_URL で指定してください(kirinuki --help に例があります)");
  const maxRows = values["max-rows"] === undefined ? undefined : Number(values["max-rows"]);

  const db = await connect(url);
  let pack: Pack;
  try {
    print(`接続しました(${db.label})`);
    pack = await collectPack(db, {
      table,
      values: keyValues,
      by: list(values.by),
      children: list(values.children),
      skip: list(values.skip),
      parentsOnly: values["parents-only"],
      maxRows,
    });
  } finally {
    await db.close();
  }

  const name = (t: Parameters<typeof tableLabel>[0]) => tableLabel(t, pack.defaultSchema);
  print(`  ${pack.tables.map((t) => `${name(t.info.table)} ${t.rows.length}行`).join(" → ")}`);
  for (const t of pack.tables.filter((t) => t.truncated)) {
    print(`  ! ${name(t.info.table)} は関係する行が${pack.maxRows}行を超えたため打ち切りました(--max-rows で変えられます)`);
  }
  for (const l of pack.unfollowed.filter((l) => l.reason === "error")) {
    print(`  ! ${name(l.direction === "parent" ? l.fk.to : l.fk.from)} を読めませんでした: ${l.error}`);
  }
  const children = [...new Set(pack.unfollowed.filter((l) => l.reason === "not-detail").map((l) => name(l.fk.from)))];
  if (children.length) print(`  たどらなかった子テーブル: ${children.join(", ")}(入れるなら --children ${children[0]} のように指定)`);

  const file = values.out ?? `${pack.start.table.name}-${keyValues.join("-")}.xlsx`.replace(/[\\/:*?"<>|\s]/g, "_");
  const xlsx = await packWorkbook(pack);
  writeFileSync(file, xlsx);
  print(`→ ${file} を書き出しました(${sizeText(xlsx.length)})`);
  if (xlsx.length > ATTACHMENT_LIMIT) {
    print("  ! M365 Copilot に添付できる目安(10MB)を超えています。--max-rows を小さくするか、--skip で大きなテーブルを外してください");
  }
}

const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`);
