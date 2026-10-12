import type { ForeignKey, TableRef } from "../core/types.js";
import { isDetail, type Pack, type PackTable, tableId, tableLabel, type UnfollowedLink } from "../pack/collect.js";
import { type CellStyle, sheetRef, Workbook } from "./xlsx.js";

const HEAD: CellStyle = { bold: true, fill: "DDEBF7", border: true };
const LABEL: CellStyle = { bold: true };
const WRAP: CellStyle = { wrap: true };
const LINK: CellStyle = { color: "0563C1", underline: true };

/**
 * The pack as an Excel workbook for an AI chat: a front sheet saying what was cut out and what was
 * not, what each table and column means, then one sheet per table. Japanese, like its readers.
 */
export function packWorkbook(pack: Pack): Promise<Buffer> {
  const book = new Workbook("Yu Gothic");
  const name = (t: TableRef) => tableLabel(t, pack.defaultSchema);
  const front = book.sheet("はじめに");
  const tablesSheet = book.sheet("テーブル説明");
  const columnsSheet = book.sheet("列説明");
  const dataSheets = new Map(pack.tables.map((t) => [tableId(t.info.table), book.sheet(name(t.info.table))]));
  const inPack = new Map(pack.tables.map((t) => [tableId(t.info.table), t]));

  // はじめに
  front.widths = { 0: 16, 1: 100 };
  front.freeze = { rows: 1 };
  front.add({ v: "項目", s: HEAD }, { v: "内容", s: HEAD });
  const item = (label: string, lines: string[]) =>
    lines.forEach((line, i) => front.add(i === 0 ? { v: label, s: LABEL } : null, { v: line, s: WRAP }));
  const start = `${name(pack.start.table)}.${pack.start.columns.map((c, i) => `${c} = ${pack.start.values[i]}`).join(" かつ ")}`;
  item("このファイルは", [`社内DB(${pack.database})から、${start} に関係する行だけを抜き出したものです`]);
  item("起点", [start]);
  item("抜き出し日時", [dateText(pack.takenAt)]);
  item("たどった関係", pack.followed.length ? pack.followed.map((l) => `${linkText(l.fk, l.direction, inPack, name)}:${l.rows}行`) : ["なし(起点の行だけです)"]);
  const asked = pack.followed.some((l) => l.direction === "child" && !detailOf(l.fk, inPack));
  const childRule = pack.parentsOnly
    ? asked
      ? "参照元の子テーブルは指定されたものだけをたどりました。"
      : "参照元の子テーブルはたどっていません。"
    : `参照元の子テーブルは明細(主キーに親のキーを含むもの)${asked ? "と指定されたもの" : ""}だけをたどりました。`;
  item("たどり方", [`宣言されている外部キーだけをたどりました。参照先(マスタなど)はすべてたどり、${childRule}1テーブルあたり最大${pack.maxRows}行です。`]);
  item("入っていないもの", missingLines(pack, name));
  item("読み方", [
    "「テーブル説明」「列説明」でデータの意味を確かめてから、各テーブルのシートを見てください。",
    "「入っていないもの」にあるデータはこのファイルにありません。あるものとして推測しないでください。",
  ]);

  // テーブル説明
  tablesSheet.freeze = { rows: 1 };
  tablesSheet.add(...["テーブル", "意味", "抜き出した行数", "元の行数", "入った経路"].map((v) => ({ v, s: HEAD })));
  for (const t of pack.tables) {
    const sheet = dataSheets.get(tableId(t.info.table))!;
    tablesSheet.add(
      { v: name(t.info.table), link: `${sheetRef(sheet.name)}!A1`, s: LINK },
      { v: t.info.comment, s: WRAP },
      t.truncated ? `${t.rows.length}(上限で打ち切り)` : t.rows.length,
      t.totalRows ?? "不明",
      routeText(t, name, inPack),
    );
  }
  tablesSheet.filter = [0, pack.tables.length, 5];

  // 列説明
  columnsSheet.freeze = { rows: 1 };
  columnsSheet.add(...["テーブル", "列", "型", "キー", "意味", "値の意味・参照先"].map((v) => ({ v, s: HEAD })));
  let columnRows = 0;
  for (const t of pack.tables) {
    const refs = referencesOf(t, pack, name);
    const key = t.info.primaryKey;
    for (const c of t.info.columns) {
      const k = key.indexOf(c.name);
      columnsSheet.add(
        name(t.info.table),
        c.name,
        c.type,
        k < 0 ? "" : key.length > 1 ? `主キー(${k + 1}/${key.length})` : "主キー",
        { v: c.comment, s: WRAP },
        { v: refs.get(c.name)?.join(" / "), s: WRAP },
      );
      columnRows++;
    }
  }
  columnsSheet.filter = [0, columnRows, 6];
  columnsSheet.widths = { 4: 40, 5: 40 };

  // one sheet per table
  for (const t of pack.tables) {
    const sheet = dataSheets.get(tableId(t.info.table))!;
    const cols = t.info.columns.map((c) => c.name);
    // CHAR columns come padded with spaces ("10 " in a CHAR(3)), which would read as a different value than "10"
    const padded = new Set(t.info.columns.filter((c) => /^n?char(acter)?(\(|$)/i.test(c.type)).map((c) => c.name));
    sheet.freeze = { rows: 1 };
    sheet.add(...cols.map((v) => ({ v, s: HEAD })));
    for (const row of t.rows) sheet.add(...cols.map((c) => (padded.has(c) && typeof row[c] === "string" ? (row[c] as string).trimEnd() : row[c])));
    if (cols.length) sheet.filter = [0, t.rows.length, cols.length];
  }
  return book.toBuffer();
}

/** orders → order_items(明細:order_items.order_id = orders.order_id) */
function linkText(fk: ForeignKey, direction: "parent" | "child", inPack: Map<string, PackTable>, name: (t: TableRef) => string): string {
  const join = fk.columns.map((c, i) => `${name(fk.from)}.${c} = ${name(fk.to)}.${fk.refColumns[i]}`).join(" かつ ");
  if (direction === "parent") return `${name(fk.from)} → ${name(fk.to)}(参照先:${join})`;
  return `${name(fk.to)} → ${name(fk.from)}(${detailOf(fk, inPack) ? "明細" : "子"}:${join})`;
}

const detailOf = (fk: ForeignKey, inPack: Map<string, PackTable>) => {
  const child = inPack.get(tableId(fk.from));
  return child ? isDetail(fk, child.info) : false;
};

function routeText(t: PackTable, name: (t: TableRef) => string, inPack: Map<string, PackTable>): string {
  if (!t.via) return "起点";
  const { fk, direction } = t.via;
  return direction === "parent" ? `${name(fk.from)} の参照先` : `${name(fk.to)} の${detailOf(fk, inPack) ? "明細" : "子"}`;
}

/** Column → "→ customers.customer_id" for each foreign key the column is part of. */
function referencesOf(t: PackTable, pack: Pack, name: (t: TableRef) => string): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const fk of pack.foreignKeys.filter((fk) => tableId(fk.from) === tableId(t.info.table))) {
    fk.columns.forEach((c, i) => {
      const text = `→ ${name(fk.to)}.${fk.refColumns[i]}`;
      const list = refs.get(c) ?? [];
      if (!list.includes(text)) refs.set(c, [...list, text]);
    });
  }
  return refs;
}

/** What the pack does not contain, so that the AI does not guess it. */
function missingLines(pack: Pack, name: (t: TableRef) => string): string[] {
  const lines: string[] = [];
  const byReason = (r: UnfollowedLink["reason"][]) => pack.unfollowed.filter((l) => r.includes(l.reason));
  for (const l of byReason(["reverse"])) {
    lines.push(`同じ ${name(l.fk.to)} を参照している、ほかの ${name(l.fk.from)} の行(起点に関係しないもの)`);
  }
  // children that are not details, one line per parent
  const children = new Map<string, { parent: TableRef; tables: string[] }>();
  for (const l of byReason(["not-detail", "parents-only"])) {
    const c = children.get(tableId(l.fk.to)) ?? { parent: l.fk.to, tables: [] };
    if (!c.tables.includes(name(l.fk.from))) c.tables.push(name(l.fk.from));
    children.set(tableId(l.fk.to), c);
  }
  for (const c of children.values()) lines.push(`${name(c.parent)} を参照している子テーブル ${c.tables.join("、")} の行(たどっていません)`);
  for (const l of byReason(["skipped"])) {
    lines.push(`${name(l.direction === "parent" ? l.fk.to : l.fk.from)} の行(入れないよう指定されました)`);
  }
  for (const l of byReason(["error"])) {
    lines.push(`${name(l.direction === "parent" ? l.fk.to : l.fk.from)} の行(読めませんでした: ${l.error ?? ""})`);
  }
  for (const t of pack.tables.filter((t) => t.truncated)) {
    lines.push(`${name(t.info.table)} の${pack.maxRows}行目より後の行(関係する行が${pack.maxRows}行を超えたため打ち切りました)`);
  }
  lines.push("外部キーが宣言されていない関係でつながる行(列名や値が似ていても、たどっていません)");
  // a table skipped or unreadable through two foreign keys is one line
  return [...new Set(lines)];
}

/** 2026-10-12 16:50, in this machine's time zone. */
function dateText(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
