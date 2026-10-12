import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32, inflateRawSync } from "node:zlib";
import { expect } from "vitest";
import type { Row } from "../src/core/types.js";
import type { Pack } from "../src/pack/collect.js";
import { salesSchema } from "./fixtures/sales.js";

export const tempDir = () => mkdtempSync(join(tmpdir(), "kirinuki-"));

/** The sales database as a SQLite file. */
export function createSalesDb(): string {
  const file = join(tempDir(), "sales.db");
  const db = new DatabaseSync(file);
  for (const sql of salesSchema("sqlite")) db.exec(sql);
  db.close();
  return file;
}

/** Table name → key columns of its rows, in pack order: a compact picture of what was collected. */
export function picture(pack: Pack): Record<string, string[]> {
  const lower = (r: Row) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));
  return Object.fromEntries(
    pack.tables.map((t) => [
      t.info.table.name.toLowerCase(),
      t.rows.map((r) =>
        t.info.primaryKey
          .map((c) => lower(r)[c.toLowerCase()])
          .map(String)
          .join("/"),
      ),
    ]),
  );
}

/** Reads a zip archive, checking each file's CRC. (From ashiato's tests.) */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(crc32(data) >>> 0, name).toBe(crc);
    files.set(name, data);
    p += 46 + nameLen;
  }
  return files;
}

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** Sheet name → rows of cell values (text or number), as written by the xlsx writer. */
export function readWorkbook(buf: Buffer): Map<string, (string | number | null)[][]> {
  const files = unzip(buf);
  const names = [...files.get("xl/workbook.xml")!.toString("utf8").matchAll(/<sheet name="([^"]*)"/g)].map((m) => unescape(m[1]!));
  const sheets = new Map<string, (string | number | null)[][]>();
  names.forEach((name, i) => {
    const xml = files.get(`xl/worksheets/sheet${i + 1}.xml`)!.toString("utf8");
    const rows: (string | number | null)[][] = [];
    for (const row of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)) {
      const cells: (string | number | null)[] = [];
      for (const c of row[2]!.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/g)) {
        const col = [...c[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const body = c[2] ?? "";
        const text = /<t[^>]*>(.*?)<\/t>/s.exec(body);
        const num = /<v>(.*?)<\/v>/.exec(body);
        cells[col] = text ? unescape(text[1]!) : num ? Number(num[1]) : null;
      }
      rows[Number(row[1]) - 1] = Array.from(cells, (v) => v ?? null);
    }
    sheets.set(name, Array.from(rows, (r) => r ?? []));
  });
  return sheets;
}
