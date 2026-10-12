# kirinuki-db

Cuts the rows related to one record out of a company database, with the meaning of each table, column and code value, into one file (Excel by default) that the user attaches to an in-house AI chat (M365 Copilot).

## Hard rules
- SELECT permission only: no triggers, no temp tables, no setting changes.
- Everything runs locally on the user's PC; never send data anywhere.
- The user runs it inside the company network; the AI sandbox cannot reach their databases. Test with SQLite / PostgreSQL that mimic the schema.
- Work databases are SQL Server and Oracle first; other major databases later.
- Default output is .xlsx because M365 Copilot does not read .db attachments; SQLite / CSV + Markdown are optional outputs.

## Layout
- `src/adapters` — one file per database (mssql, oracle, postgres, sqlite): tables, columns with types and comments, primary keys, declared foreign keys, and `selectRows` (rows matching key tuples, values bound so the database converts them, not the column). Drivers (mssql, oracledb, pg) are optional peer dependencies loaded with `loadDriver()`.
- `src/pack/collect.ts` — the traversal: parents always, children only when they are details (the foreign key is part of the child's primary key) or named with `--children`, never back down the foreign key a parent was reached through. Records what was not followed, for the front sheet.
- `src/export` — `workbook.ts` lays out the pack (はじめに, テーブル説明, 列説明, one sheet per table); `xlsx.ts` / `zip.ts` are the dependency-free writer copied from ashiato.
- `src/cli` — the `kirinuki` command (Japanese messages).
- `src/core/normalize.ts` and the adapters' connection code come from the sister project ashiato.

## Commands
- `pnpm test` — SQLite tests. Real servers run when `KIRINUKI_TEST_{POSTGRES,MSSQL,ORACLE}_URL` is set (CI sets all three; Oracle also needs `KIRINUKI_TEST_ORACLE_ADMIN_URL`). The integration test connects as a user granted only SELECT, so catalog queries are checked against that permission.
- `pnpm typecheck`, `pnpm build`

## Docs
- `docs/concept.md` — concept, findings from the first test with an AI, and the staged plan (stage 1 is implemented).
- `docs/sample-pack.xlsx` — hand-made example of the output (fictional data).
- Sister project: github.com/ishibashi0112/ashiato (records DB changes caused by app actions; its read-only adapters may be reused).
