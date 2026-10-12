import { zip, type ZipEntry } from "./zip.js";

/**
 * A small .xlsx writer: inline-string / number / boolean cells, cell styles, column widths, frozen
 * header rows, auto filters, links between sheets and pictures. Enough for packs and evidence workbooks,
 * without a runtime dependency. Copied from ashiato (github.com/ishibashi0112/ashiato).
 */

export type CellValue = string | number | boolean | null | undefined;

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  /** Font size in points. */
  size?: number;
  /** Font color, `RRGGBB`. */
  color?: string;
  /** Background color, `RRGGBB`. */
  fill?: string;
  border?: boolean;
  wrap?: boolean;
}

export interface Cell {
  v: CellValue;
  s?: CellStyle;
  /** A place in the workbook this cell links to, e.g. `'Sheet 2'!A1`. */
  link?: string;
  /** Leave the cell out of the column width (long text that may spill into the empty cells next to it). */
  noWidth?: boolean;
}

export interface Picture {
  data: Buffer;
  type: "jpeg" | "png";
  /** Zero-based cell the picture's top left corner is in. */
  row: number;
  col: number;
  /** Size shown, in pixels. */
  width: number;
  height: number;
  description?: string;
}

/** Excel's limits. */
export const MAX_ROWS = 1_048_576;
const MAX_TEXT = 32_767;
/** Widest column the widths computed from the content go. */
const MAX_WIDTH = 60;

/** Default row height used by every sheet, in points (20 px). Pictures reserve rows by it. */
export const ROW_HEIGHT_PT = 15;
export const ROW_HEIGHT_PX = 20;

export class Sheet {
  readonly pictures: Picture[] = [];
  /** Rows / columns kept in view while scrolling. */
  freeze?: { rows: number; cols?: number };
  /** Zero-based [first row, last row, column count] of an auto filter. */
  filter?: [number, number, number];
  /** Column widths in characters, overriding the computed ones. */
  widths: Record<number, number> = {};
  /** Rows written so far (empty ones included). */
  rowCount = 0;

  // A table can have 100,000s of rows: each row is written to XML as it is added (no cell objects
  // kept), and the XML is collected in buffers, as one string could outgrow V8's limit.
  /** @internal */ readonly chunks: Buffer[] = [];
  /** @internal */ readonly links: string[] = [];
  /** @internal */ readonly measured = new Map<number, number>();
  private rowsXml: string[] = [];
  private pending = 0;

  constructor(
    readonly name: string,
    private readonly styles: Styles,
  ) {}

  /** Appends a row; returns its zero-based index. */
  add(...cells: (Cell | CellValue)[]): number {
    const r = this.rowCount++;
    const out: string[] = [];
    cells.forEach((c, col) => {
      const cell = isCell(c) ? c : { v: c };
      if ((cell.v === null || cell.v === undefined || cell.v === "") && !cell.s) return;
      const ref = `${colName(col)}${r + 1}`;
      out.push(cellXml(ref, cell.v, cell.s ? ` s="${this.styles.id(cell.s)}"` : ""));
      if (cell.link) this.links.push(`<hyperlink ref="${ref}" location="${esc(cell.link)}"/>`);
      if (!cell.noWidth && cell.v !== null && cell.v !== undefined) this.measure(col, String(cell.v), cell.s);
    });
    if (out.length === 0) return r;
    const row = `<row r="${r + 1}">${out.join("")}</row>`;
    this.rowsXml.push(row);
    this.pending += row.length;
    if (this.pending > 1 << 22) this.flush();
    return r;
  }

  /** Appends empty rows. */
  skip(n = 1): void {
    this.rowCount += n;
  }

  /** Appends a picture below the last row and reserves the rows it covers. */
  picture(p: Omit<Picture, "row" | "col">, col = 0): void {
    this.pictures.push({ ...p, row: this.rowCount, col });
    this.skip(Math.ceil(p.height / ROW_HEIGHT_PX) + 1);
  }

  /** @internal The rows' XML. */
  flush(): void {
    if (this.rowsXml.length) this.chunks.push(Buffer.from(this.rowsXml.join(""), "utf8"));
    this.rowsXml = [];
    this.pending = 0;
  }

  private measure(col: number, text: string, s: CellStyle | undefined) {
    const scale = (s?.size ?? 11) / 11;
    const current = this.measured.get(col) ?? 0;
    // only when it could widen the column: a character is at most two wide, and columns stop at MAX_WIDTH
    if (current < MAX_WIDTH && text.length * 2 * scale + 1 > current) {
      this.measured.set(col, Math.max(current, textWidth(text) * scale + (s?.bold ? 1 : 0)));
    }
  }
}

export class Workbook {
  readonly sheets: Sheet[] = [];
  private readonly names = new Set<string>();
  private readonly styles: Styles;

  constructor(font = "Calibri") {
    this.styles = new Styles(font);
  }

  /** Adds a sheet. The name is made valid and unique (31 characters, no `[]:*?/\`). */
  sheet(name: string): Sheet {
    let base = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31).replace(/^'+|'+$/g, "").trim() || "Sheet";
    let unique = base;
    for (let n = 2; this.names.has(unique.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      base = base.slice(0, 31 - suffix.length);
      unique = `${base}${suffix}`;
    }
    this.names.add(unique.toLowerCase());
    const sheet = new Sheet(unique, this.styles);
    this.sheets.push(sheet);
    return sheet;
  }

  toBuffer(): Promise<Buffer> {
    const entries: ZipEntry[] = [];
    const overrides: string[] = [];
    let pictureCount = 0;
    let drawingCount = 0;
    const definedNames: string[] = [];

    this.sheets.forEach((sheet, i) => {
      const n = i + 1;
      let drawing: number | undefined;
      if (sheet.pictures.length > 0) {
        drawing = ++drawingCount;
        const rels: string[] = [];
        const anchors = sheet.pictures.map((p, j) => {
          const media = `image${++pictureCount}.${p.type}`;
          entries.push({ name: `xl/media/${media}`, data: p.data, store: true });
          rels.push(rel(`rId${j + 1}`, "image", `../media/${media}`));
          return anchor(p, j + 1);
        });
        entries.push({
          name: `xl/drawings/drawing${drawing}.xml`,
          data: `${XML}<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">${anchors.join("")}</xdr:wsDr>`,
        });
        entries.push({ name: `xl/drawings/_rels/drawing${drawing}.xml.rels`, data: rels_(rels) });
        overrides.push(override(`/xl/drawings/drawing${drawing}.xml`, "application/vnd.openxmlformats-officedocument.drawing+xml"));
        entries.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: rels_([rel("rId1", "drawing", `../drawings/drawing${drawing}.xml`)]) });
      }
      entries.push({ name: `xl/worksheets/sheet${n}.xml`, data: sheetXml(sheet, i === 0, drawing !== undefined) });
      overrides.push(override(`/xl/worksheets/sheet${n}.xml`, "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"));
      if (sheet.filter) {
        const [from, to, cols] = sheet.filter;
        definedNames.push(
          `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(sheetRef(sheet.name))}!$A$${from + 1}:$${colName(cols - 1)}$${to + 1}</definedName>`,
        );
      }
    });

    const workbook =
      `${XML}<workbook xmlns="${NS.main}" xmlns:r="${NS.r}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
      this.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      `</sheets>${definedNames.length ? `<definedNames>${definedNames.join("")}</definedNames>` : ""}</workbook>`;
    const workbookRels = rels_([
      ...this.sheets.map((_, i) => rel(`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`)),
      rel(`rId${this.sheets.length + 1}`, "styles", "styles.xml"),
    ]);
    const types =
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/>` +
      override("/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml") +
      override("/xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml") +
      overrides.join("") +
      `</Types>`;

    return zip([
      { name: "[Content_Types].xml", data: types },
      { name: "_rels/.rels", data: rels_([rel("rId1", "officeDocument", "xl/workbook.xml")]) },
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
      // styles last: the sheets above register the styles they use
      ...entries,
      { name: "xl/styles.xml", data: this.styles.xml() },
    ]);
  }
}

const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const NS = {
  main: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  xdr: "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
};

const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"/>`;
const rels_ = (list: string[]) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.join("")}</Relationships>`;
const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="${type}"/>`;

/** EMUs per pixel at 96 dpi. */
const EMU = 9525;

function anchor(p: Picture, id: number): string {
  const cx = Math.round(p.width * EMU);
  const cy = Math.round(p.height * EMU);
  return (
    `<xdr:oneCellAnchor><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>${4 * EMU}</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id + 1}" name="Picture ${id}" descr="${esc(p.description ?? "")}"/>` +
    `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:ln w="9525"><a:solidFill><a:srgbClr val="A6A6A6"/></a:solidFill></a:ln></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`
  );
}

/** `A`, `B`, … `Z`, `AA`, … for a zero-based column. */
export function colName(col: number): string {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** A sheet name as written in a reference: always quoted, quotes doubled. */
export const sheetRef = (name: string) => `'${name.replace(/'/g, "''")}'`;

const isCell = (c: Cell | CellValue): c is Cell => typeof c === "object" && c !== null;

function sheetXml(sheet: Sheet, selected: boolean, drawing: boolean): Buffer {
  sheet.flush();
  const widths = sheet.measured;
  const links = sheet.links;
  const colCount = Math.max(widths.size ? Math.max(...widths.keys()) + 1 : 0, ...Object.keys(sheet.widths).map((k) => Number(k) + 1));
  const cols: string[] = [];
  for (let c = 0; c < colCount; c++) {
    const w = sheet.widths[c] ?? Math.min(MAX_WIDTH, Math.max(6, Math.ceil((widths.get(c) ?? 0) + 2)));
    cols.push(`<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`);
  }

  let pane = "";
  if (sheet.freeze && (sheet.freeze.rows || sheet.freeze.cols)) {
    const { rows: fr, cols: fc = 0 } = sheet.freeze;
    const top = `${colName(fc)}${fr + 1}`;
    const active = fr && fc ? "bottomRight" : fr ? "bottomLeft" : "topRight";
    pane =
      `<pane${fc ? ` xSplit="${fc}"` : ""}${fr ? ` ySplit="${fr}"` : ""} topLeftCell="${top}" activePane="${active}" state="frozen"/>` +
      `<selection pane="${active}" activeCell="${top}" sqref="${top}"/>`;
  }
  const filter = sheet.filter ? `<autoFilter ref="A${sheet.filter[0] + 1}:${colName(sheet.filter[2] - 1)}${sheet.filter[1] + 1}"/>` : "";

  const head =
    `${XML}<worksheet xmlns="${NS.main}" xmlns:r="${NS.r}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` +
    `<sheetViews><sheetView workbookViewId="0"${selected ? ` tabSelected="1"` : ""}>${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="${ROW_HEIGHT_PT}" customHeight="1"/>` +
    (cols.length ? `<cols>${cols.join("")}</cols>` : "") +
    `<sheetData>`;
  const tail =
    `</sheetData>${filter}` +
    (links.length ? `<hyperlinks>${links.join("")}</hyperlinks>` : "") +
    `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>` +
    `<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>` +
    `<headerFooter><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter>` +
    (drawing ? `<drawing r:id="rId1"/>` : "") +
    `</worksheet>`;
  return Buffer.concat([Buffer.from(head, "utf8"), ...sheet.chunks, Buffer.from(tail, "utf8")]);
}

function cellXml(ref: string, v: CellValue, s: string): string {
  if (v === null || v === undefined) return `<c r="${ref}"${s}/>`;
  if (typeof v === "boolean") return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  // Excel keeps 15 significant digits: longer numbers (IDs) would be shown rounded, so they go in as text.
  // So do whole numbers of 12 digits or more (a JAN code), which Excel shows as 4.90123E+12.
  if (typeof v === "number" && Number.isFinite(v) && significantDigits(v) <= 15 && !(Number.isInteger(v) && Math.abs(v) >= 1e11)) {
    return `<c r="${ref}"${s}><v>${v}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${cellText(String(v))}</t></is></c>`;
}

function significantDigits(n: number): number {
  const [mantissa] = Math.abs(n).toExponential().split("e");
  return mantissa!.replace(".", "").length;
}

/** Text of a cell: within Excel's length limit, with characters XML can't carry written the way Excel reads them back. */
function cellText(s: string): string {
  if (!SPECIAL.test(s) && s.length <= MAX_TEXT) return s;
  const text = s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
  return esc(
    text
      // `_x0041_` in a cell means "A" to Excel: a literal one keeps its leading underscore by escaping it
      .replace(/_(x[0-9a-fA-F]{4}_)/g, "_x005F_$1")
      // XML readers turn a carriage return into a line feed: written escaped, as Excel itself does
      .replace(/[\x00-\x08\x0b-\x1f]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}_`),
  );
}

/** Anything cellText has to change. */
const SPECIAL = /[&<>"\x00-\x08\x0b-\x1f\ud800-\udfff\ufffe\uffff]|_x[0-9a-fA-F]{4}_/;
/** Characters XML 1.0 can't contain. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const NOT_CHARACTER = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\ufffe\uffff]/g;

/** XML text: escaped, and without the characters XML can't contain. */
export function esc(s: string): string {
  const escaped = s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;")).replace(CONTROL, "\ufffd");
  return /[\ud800-\udfff\ufffe\uffff]/.test(escaped) ? escaped.replace(NOT_CHARACTER, "\ufffd") : escaped;
}

/** Width of text in Excel's character units: East Asian wide characters take two. */
export function textWidth(s: string): number {
  let max = 0;
  for (const line of s.split("\n")) {
    let w = 0;
    for (const ch of line) w += wide(ch.codePointAt(0)!) ? 2 : 1;
    max = Math.max(max, w);
  }
  return max;
}

function wide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f300
  );
}

class Styles {
  private readonly fonts: string[] = [];
  private readonly fills: string[] = [`<fill><patternFill patternType="none"/></fill>`, `<fill><patternFill patternType="gray125"/></fill>`];
  private readonly borders: string[] = [`<border><left/><right/><top/><bottom/><diagonal/></border>`];
  private readonly xfs: string[] = [`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`];
  private readonly ids = new Map<string, number>();

  constructor(private readonly fontName: string) {
    this.fonts.push(this.font({}));
  }

  private readonly byObject = new WeakMap<CellStyle, number>();

  id(s: CellStyle): number {
    // most cells share a few style objects
    const known = this.byObject.get(s);
    if (known !== undefined) return known;
    const id = this.idOf(s);
    this.byObject.set(s, id);
    return id;
  }

  private idOf(s: CellStyle): number {
    const key = JSON.stringify([s.bold, s.italic, s.strike, s.underline, s.size, s.color, s.fill, s.border, s.wrap]);
    let id = this.ids.get(key);
    if (id === undefined) {
      const fontId = index(this.fonts, this.font(s));
      const fillId = s.fill ? index(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
      const side = (name: string) => `<${name} style="thin"><color rgb="FFBFBFBF"/></${name}>`;
      const borderId = s.border ? index(this.borders, `<border>${side("left")}${side("right")}${side("top")}${side("bottom")}<diagonal/></border>`) : 0;
      const align = s.wrap ? `<alignment vertical="top" wrapText="1"/>` : `<alignment vertical="top"/>`;
      this.xfs.push(
        `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`,
      );
      id = this.xfs.length - 1;
      this.ids.set(key, id);
    }
    return id;
  }

  private font(s: CellStyle): string {
    return (
      `<font>${s.bold ? "<b/>" : ""}${s.italic ? "<i/>" : ""}${s.strike ? "<strike/>" : ""}${s.underline ? `<u/>` : ""}` +
      `<sz val="${s.size ?? 11}"/>${s.color ? `<color rgb="FF${s.color}"/>` : `<color theme="1"/>`}<name val="${esc(this.fontName)}"/><family val="2"/></font>`
    );
  }

  xml(): string {
    return (
      `${XML}<styleSheet xmlns="${NS.main}">` +
      `<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join("")}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join("")}</borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`
    );
  }
}

function index(list: string[], item: string): number {
  const i = list.indexOf(item);
  if (i >= 0) return i;
  list.push(item);
  return list.length - 1;
}
