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
  /**
   * Key columns in key order: the primary key, or for a table without one, the columns of its
   * shortest unique index (`keyFromIndex`). Empty when the table has neither.
   */
  primaryKey: string[];
  keyFromIndex?: boolean;
  comment?: string;
}

/**
 * A relation between two tables: `from.columns` reference `to.refColumns` (same order).
 * declared: a foreign key in the database; inferred: guessed from column names (see inferRelations);
 * file: written in a relations file.
 */
export interface ForeignKey {
  name: string;
  /** The referencing table (the child: order_items). */
  from: TableRef;
  columns: string[];
  /** The referenced table (the parent: orders). */
  to: TableRef;
  refColumns: string[];
  source?: "declared" | "inferred" | "file";
}

/** What `DbAdapter.catalog` tells about one table: enough to guess relations without reading rows. */
export interface CatalogTable {
  table: TableRef;
  columns: { name: string; type: string }[];
  primaryKey: string[];
  /** Key columns of each index, primary key and unique constraints included. Expression indexes are left out. */
  indexes: { columns: string[]; unique: boolean }[];
}
