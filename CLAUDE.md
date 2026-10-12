# kirinuki-db

Cuts the rows related to one record out of a company database, with the meaning of each table, column and code value, into one file (Excel by default) that the user attaches to an in-house AI chat (M365 Copilot).

## Hard rules
- SELECT permission only: no triggers, no temp tables, no setting changes.
- Everything runs locally on the user's PC; never send data anywhere.
- The user runs it inside the company network; the AI sandbox cannot reach their databases. Test with SQLite / PostgreSQL that mimic the schema.
- Work databases are SQL Server and Oracle first; other major databases later.
- Default output is .xlsx because M365 Copilot does not read .db attachments; SQLite / CSV + Markdown are optional outputs.

## Layout
- `src/adapters` — one file per database (mssql, oracle, postgres, sqlite): tables, columns with types and comments, primary keys, declared foreign keys, `catalog` (every table's columns, primary key and indexes in one go, for guessing relations), and `selectRows` (rows matching key tuples, values bound so the database converts them, not the column). Drivers (mssql, oracledb, pg) are optional peer dependencies loaded with `loadDriver()`.
- `src/pack/relations.ts` — the relations followed: declared foreign keys, guesses (a table holding columns named like another table's whole key — its primary key, else its shortest unique index — references it; skipped when types differ or the key's names are the whole key of 3+ tables) and a relations file (`child(cols) -> parent(cols)`, `!` removes). Many work databases declare no foreign keys at all.
- `src/pack/collect.ts` — the traversal: parents always; children only when they are details (the relation's columns are the leading columns of the child's key) or named with `--children`; never back down the relation a parent was reached through, nor into the other details of a parent reached up from one of its details (a company code leading every key would otherwise pull in the whole company); details of a parent at most `DETAIL_LIMIT` (100) rows. Records what was not followed, for the front sheet.
- `src/export` — `workbook.ts` lays out the pack (はじめに, テーブル説明, 列説明, one sheet per table); `xlsx.ts` / `zip.ts` are the dependency-free writer copied from ashiato.
- `src/cli` — the `kirinuki` command (Japanese messages).
- `src/core/normalize.ts` and the adapters' connection code come from the sister project ashiato.

## Commands
- `pnpm test` — SQLite tests. Real servers run when `KIRINUKI_TEST_{POSTGRES,MSSQL,ORACLE}_URL` is set (CI sets all three; Oracle also needs `KIRINUKI_TEST_ORACLE_ADMIN_URL`). The integration test connects as a user granted only SELECT, so catalog queries are checked against that permission.
- `pnpm typecheck`, `pnpm build`

## Docs
- `docs/concept.md` — concept, findings from the first test with an AI, and the staged plan (stage 1 is implemented, with relation guessing brought forward from stage 3).
- `docs/sample-pack.xlsx` — hand-made example of the output (fictional data).
- Sister project: github.com/ishibashi0112/ashiato (records DB changes caused by app actions; its read-only adapters may be reused).
