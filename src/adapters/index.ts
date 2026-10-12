import type { DbAdapter } from "./types.js";

export type { DbAdapter } from "./types.js";

/**
 * Opens a read-only adapter from a connection URL:
 *   mssql://user:pass@host:1433/database?instance=SQLEXPRESS&domain=CORP
 *   oracle://user:pass@host:1521/service?schema=OWNER
 *   postgres://user:pass@host:5432/database
 *   sqlite:./test.db
 */
export async function connect(connection: string): Promise<DbAdapter> {
  try {
    return await open(connection);
  } catch (e) {
    if (e instanceof URIError) {
      throw new Error("接続URLのユーザー名かパスワードを読めませんでした。記号はパーセントエンコードしてください(% → %25、@ → %40、: → %3A、# → %23)");
    }
    throw e;
  }
}

async function open(connection: string): Promise<DbAdapter> {
  if (connection.startsWith("sqlite:")) {
    const { connectSqlite } = await import("./sqlite.js");
    return connectSqlite(connection.slice("sqlite:".length).replace(/^\/\//, ""));
  }
  const url = new URL(connection);
  switch (url.protocol) {
    case "mssql:":
    case "sqlserver:": {
      const { connectMssql } = await import("./mssql.js");
      return connectMssql(url);
    }
    case "oracle:": {
      const { connectOracle } = await import("./oracle.js");
      return connectOracle(url);
    }
    case "postgres:":
    case "postgresql:": {
      const { connectPostgres } = await import("./postgres.js");
      return connectPostgres(url);
    }
    default:
      throw new Error(`対応していない接続URLです: ${url.protocol}(mssql:、oracle:、postgres:、sqlite: が使えます)`);
  }
}
