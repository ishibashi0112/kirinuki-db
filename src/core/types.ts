/** A row as read from the database, with values already normalized to JSON-safe types. */
export type Row = Record<string, JsonValue>;

export type JsonValue = string | number | boolean | null;

export interface TableRef {
  /** Schema / owner. Omitted for databases without schemas (SQLite). */
  schema?: string;
  name: string;
}

export interface Column {
  name: string;
  /** The type as the database writes it: varchar(10), NUMBER(10,2), datetime2(3)... */
  type: string;
  nullable: boolean;
  /** The database's own description (SQL Server MS_Description, Oracle / PostgreSQL COMMENT). */
  comment?: string;
}

export interface TableInfo {
  table: TableRef;
  columns: Column[];
  /** Primary key columns in key order. Empty when the table has none. */
  primaryKey: string[];
  comment?: string;
}

/** A declared foreign key: `from.columns` reference `to.refColumns` (same order). */
export interface ForeignKey {
  name: string;
  /** The referencing table (the child: order_items). */
  from: TableRef;
  columns: string[];
  /** The referenced table (the parent: orders). */
  to: TableRef;
  refColumns: string[];
}
