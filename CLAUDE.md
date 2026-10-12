# kirinuki-db

Cuts the rows related to one record out of a company database, with the meaning of each table, column and code value, into one file (Excel by default) that the user attaches to an in-house AI chat (M365 Copilot).

## Hard rules
- SELECT permission only: no triggers, no temp tables, no setting changes.
- Everything runs locally on the user's PC; never send data anywhere.
- The user runs it inside the company network; the AI sandbox cannot reach their databases. Test with SQLite / PostgreSQL that mimic the schema.
- Work databases are SQL Server and Oracle first; other major databases later.
- Default output is .xlsx because M365 Copilot does not read .db attachments; SQLite / CSV + Markdown are optional outputs.

## Docs
- `docs/concept.md` — concept, findings from the first test with an AI, and the staged plan.
- `docs/sample-pack.xlsx` — hand-made example of the output (fictional data).
- Sister project: github.com/ishibashi0112/ashiato (records DB changes caused by app actions; its read-only adapters may be reused).
