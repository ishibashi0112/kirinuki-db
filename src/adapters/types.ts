import type { ForeignKey, JsonValue, Row, TableInfo, TableRef } from "../core/types.js";

/**
 * A read-only view of a database. Every method must work with SELECT permission only:
 * no triggers, no temp tables, no setting changes.
 */
export interface DbAdapter {
  readonly dialect: "sqlite" | "postgres" | "mssql" | "oracle";
  /** For the pack's front sheet: the kind of database and its name (SQL Server: salesdb). Never the host, user or password. */
  readonly label: string;
  /** Schema that unqualified table names mean (dbo, the Oracle user...). Undefined for SQLite. */
  readonly defaultSchema?: string;
  listTables(): Promise<TableRef[]>;
  describeTable(table: TableRef): Promise<TableInfo>;
  /** Every declared foreign key between the tables this user can see. */
  foreignKeys(): Promise<ForeignKey[]>;
  countRows(table: TableRef): Promise<number>;
  /**
   * The rows whose `columns` equal one of `keys` (tuples in the order of `columns`; no nulls),
   * ordered by the primary key, at most `limit` of them. Values are bound as parameters, converted
   * to each column's type by the database so that its indexes are used.
   */
  selectRows(table: TableRef, columns: string[], keys: JsonValue[][], limit: number): Promise<Row[]>;
  close(): Promise<void>;
}
