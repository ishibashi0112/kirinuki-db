import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { connect, type DbAdapter } from "../adapters/index.js";
import type { ForeignKey, TableRef } from "../core/types.js";
import { packWorkbook } from "../export/workbook.js";
import { collectPack, DEFAULT_MAX_ROWS, DETAIL_LIMIT, type Pack } from "../pack/collect.js";
import { resolveTable, tableId, tableLabel } from "../pack/names.js";
import { indexed, loadRelations, relationLine } from "../pack/relations.js";

const HELP = `kirinuki — 社内DBから、ある件に関係する行だけを説明つきの Excel に切り抜きます

使い方:
  kirinuki <テーブル> <キーの値...> --db <接続URL> [オプション]
  kirinuki relations --db <接続URL> [--table <表>] [--out <file>]   たどる関係の一覧

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
  --relations <file>     関係ファイル(名前の違う列の関係を足す、推測を取り消す)
  --no-infer             列名から関係を推測しない(外部キーと関係ファイルだけ)
  --out <file>           書き出すファイル(既定: <テーブル>-<値>.xlsx)

関係(どの列がどのテーブルを指すか):
  DBに宣言された外部キーに加えて、ほかのテーブルの主キー(なければ一意索引)と同じ名前の列を
  そのテーブルへの参照とみなします(order_items.order_id → orders)。名前が違う関係は関係ファイルに
  1行ずつ書きます。先頭に ! を付けると、その関係を使いません:
    orders(tokui_cd) -> customers(customer_cd)
    ! shipments(order_id) -> orders(order_id)
  kirinuki relations で、いま使われる関係の一覧を出せます。

たどり方:
  参照先(注文 → 得意先、注文明細 → 商品)はいつもたどります。
  子テーブル(その行を参照している行)は、明細(主キーの先頭に親のキーがあるもの。注文 → 注文明細、
  商品 → 在庫)だけです。参照先からの明細は${DETAIL_LIMIT}行までのときだけ入れます。
  たどってきた関係を逆には戻りません(商品から、同じ商品を使う他の注文明細へは進みません)。
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
      relations: { type: "string" },
      "no-infer": { type: "boolean" },
      table: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [table, ...keyValues] = positionals;
  if (values.help || !table) {
    print(HELP);
    return;
  }
  const listing = table === "relations" && keyValues.length === 0;
  if (keyValues.length === 0 && !listing) throw new Error(`${table} のどの行かを、キーの値で指定してください(例: kirinuki ${table} 1042)`);
  const url = values.db ?? process.env.KIRINUKI_DB_URL;
  if (!url) throw new Error("接続先を --db か環境変数 KIRINUKI_DB_URL で指定してください(kirinuki --help に例があります)");
  const maxRows = values["max-rows"] === undefined ? undefined : Number(values["max-rows"]);
  const relations = values.relations === undefined ? undefined : { name: basename(values.relations), text: readFileSync(values.relations, "utf8") };
  const infer = !values["no-infer"];

  const db = await connect(url);
  if (listing) {
    try {
      print(`接続しました(${db.label})`);
      const text = await relationsText(db, { infer, relations, table: values.table });
      if (values.out) {
        writeFileSync(values.out, text);
        print(`→ ${values.out} に書き出しました`);
      } else {
        print(text);
      }
    } finally {
      await db.close();
    }
    return;
  }
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
      infer,
      relations,
    });
  } finally {
    await db.close();
  }

  const name = (t: TableRef) => tableLabel(t, pack.defaultSchema);
  print(`  ${pack.tables.map((t) => `${name(t.info.table)} ${t.rows.length}行`).join(" → ")}`);
  const guessed = pack.followed.filter((l) => l.fk.source === "inferred").length;
  if (guessed) print(`  たどった関係のうち${guessed}つは列名からの推測です(kirinuki relations で一覧を確かめられます)`);
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

/** The relations, as lines of a relations file grouped by where they come from. */
async function relationsText(db: DbAdapter, options: { infer: boolean; relations?: { name: string; text: string }; table?: string }): Promise<string> {
  const tables = await db.listTables();
  const { catalog, declared, inferred, file, all } = await loadRelations(db, tables, options);
  const only = options.table && tableId(resolveTable(options.table, tables, db.defaultSchema, db.dialect));
  const used = new Set(all);
  const pick = (list: ForeignKey[]) => list.filter((fk) => used.has(fk) && (!only || tableId(fk.from) === only || tableId(fk.to) === only));
  const name = (t: TableRef) => tableLabel(t, db.defaultSchema);
  const section = (title: string, list: ForeignKey[], evidence: boolean) => {
    const lines = pick(list).map((fk) => `${relationLine(fk, name)}${evidence ? `    # ${indexed(fk, catalog) ? "索引あり" : "索引なし"}` : ""}`);
    return lines.length ? [`# ${title}`, ...lines, ""] : [];
  };
  return [
    "# kirinuki の関係ファイル。子テーブル(列) -> 親テーブル(列) を1行ずつ。先頭に ! を付けた行は、その関係を使いません",
    "",
    ...section("DBに宣言された外部キー", declared, false),
    ...section(`関係ファイル(${options.relations?.name ?? ""})`, file?.add ?? [], false),
    ...section("主キーと同じ名前の列からの推測(索引あり = 子の列で引ける索引がある)", inferred, true),
    ...(file?.remove.length ? [`# 関係ファイルで取り消した関係`, ...file.remove.map((fk) => `! ${relationLine(fk, name)}`), ""] : []),
  ].join("\n");
}

const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`);
