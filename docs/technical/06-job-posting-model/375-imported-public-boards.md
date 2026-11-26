**Imported public boards.**
`pnpm sources:import-boards --profile real|demo --file <json> [--dry-run]` imports a reviewed list of public Greenhouse, Lever, and Ashby boards (a scout run's output) as discovery sources (`packages/agent/src/board-import.ts`, `packages/agent/scripts/import-boards.ts`).
`--profile` and `--file` are required, so an import is never aimed at the real workspace by accident.
The file holds a JSON array of rows `{ company, board_url, ats, evidence_url, has_intern_posting }`, at most 5,000 rows and 5 MB.
Each row is validated with Zod: a company name of 1 to 160 characters, `ats` one of greenhouse, lever, or ashby, `evidence_url` a public https link, and `has_intern_posting` true or false; a row that names the link `source_url` instead of `evidence_url` is accepted.
`board_url` must pass `parsePublicBoardUrl` (a board root with only its company slug), and `ats` must match the board it names.
A row that fails is reported as invalid with its row number and reason, and the rest of the file is still imported.
Boards are deduped by kind and slug, case-insensitively, against every existing discovery source (enabled or not) and against earlier rows in the file.
No target rule works at the company level (term, role, location, pay, and source rules all read the posting), so every valid row is imported and the normal posting-level rules decide each posting the board lists.
One import adds at most 300 new boards; rows whose board lists an internship now go first, then file order, and the rest are reported as over the cap for a later import.
The command prints the added, already present, invalid, and over-cap counts, each added board, each invalid row's reason, and each over-cap row, then a `BOARD_IMPORT_REPORT` line with the counts as JSON.
`--dry-run` opens the workspace database read-only (no migration applied) and writes nothing.
A real import saves every added board in one transaction through `saveImportedBoardSources` in `packages/db/src/discovery-repository.ts`.
Each imported board records where it came from: `imported_from` ("scout run (<file name>)"), `imported_at`, and `evidence_url` (migration 0037).
An imported board is saved as its canonical root URL (`boards.greenhouse.io`, `jobs.lever.co`, or `jobs.ashbyhq.com` plus the slug) with the company name as its label, which becomes the company name of the postings it lists, and a limit of 6 checks per minute.
`has_intern_posting` only orders rows before the cap and is not stored.
**Board polling.**
`pnpm pipeline:run` checks public boards after the GitHub lists, at most 4 board fetches at a time, with one board's ingest at a time so duplicate checks across boards stay correct (`checkPublicBoards` in `packages/agent/src/discovery-orchestrator.ts`).
Each board is checked at most once every 6 hours, measured from its `last_fetched_at`, oldest first, and at most 100 boards per pass; the rest wait for a later pass (`packages/agent/src/board-polling.ts`).
A board whose fetch fails is backed off: it is checked again after 12 hours, doubling with each failure in a row up to 7 days, and after 7 days at once when it answered 404 or 410.
The board's `failure_count`, `last_error`, and `retry_after` record this, and a successful fetch clears them; a failing board stays enabled and is never retried every pass.
The dashboard's Check board still checks a board on demand, and the Jobs page shows where an imported board came from and why a failing board is backed off.
The pass logs a line only for a board that stored, prepared, or failed, plus one summary line with the boards checked, failed, not due, backed off, and left for a later pass.
A board with no internship postings right now finishes as an empty run with the note "No internship postings on this board right now." instead of failing.
The list doorbell (`pnpm pipeline:watch`) still rings only for GitHub lists, so boards are checked only by `pnpm pipeline:run`.
No conditional requests are sent (Greenhouse's ETag comes with `cache-control: max-age=0, private`); the interval and the back-off bound the load on the board APIs.
