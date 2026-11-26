**Discovery trace.**
Every source check by the pipeline pass and by the dashboard's Check board writes a per-listing decision log, so "why wasn't this posting picked up" can be answered from the trace alone (`packages/agent/src/discovery-trace.ts`).
The trace lives in `<workspace data>/discovery-traces/<YYYY-MM-DD>.jsonl`, named by the UTC date the pass started, with mode 600 in a folder with mode 700.
Each line is one JSON object, appended the moment the decision is made, so a crash keeps everything written before it.
A pass line starts each check, with the list, a short pass id, the time, and the source's label.
A row line records one listed row: the list, the row number, company, title, link and its host, the decision, and the reason.
The decisions are read (and then stored), already known, older than the age limit, closed on the list, not an internship, another season, listed twice, invalid link, failed to parse, unsupported, unavailable, and not reached this check (past the scan limit, the posting limit, the request budget, or the time limit, and tried again on the next check).
Row numbers are the 1-based position in the list's parse output: file order for Simplify and Speedy, and for Vansh the valid rows newest first, then the malformed rows.
An ingest line records what ingestion did with each resolved posting: stored new, updated, duplicate, already in the live pipeline, skipped by the candidate's discovery feedback, failed to store, or past the batch limit.
A fetch line records each public board request: the API endpoint and its host, the HTTP status, fetched or failed with the reason, and the board's job, internship-title, and kept counts; a board's dropped internship rows (invalid link, description under 80 characters, past the 100-posting limit) and its kept rows are row lines, and its other titles are only counted on the fetch line.
An oversized board read again (Greenhouse's job list and postings, Lever's pages) writes one fetch line naming the list or first-page endpoint, with how it was read in its reason; its posting and page requests are not traced one by one.
Board checks write their pass line with `full: false` and never write quiet rows, so a pass with many boards does not re-read the day's trace file for each one.
An end line closes the check with counts by decision, counts by reason, and counts by host for the rows that were dropped, plus the error when the check failed.
A read row that was then stored counts under its ingest decision, so the end counts show final decisions.
Quiet rows (already known, older than the age limit, closed on the list, not an internship) are written only on the first pass of the UTC day for each list, and are always counted.
Trace files more than 14 days old are removed when a new check starts.
The trace holds public list and posting data only (company, title, public links, and reason text), never candidate data, headers, or secrets.
A trace that cannot be written never stops discovery; the pipeline logs "discovery trace not written" with the error.
`pnpm discovery:trace [--profile real|demo] [--passes N] [--find <text>]` prints the newest passes with their counts, top reasons, and dropped hosts, or every kept line whose company, title, or link contains the text.
The target rules are unchanged: unpaid, role, location, and term still decide what is pursued, and ruled-out stored postings stay visible with their reasons as before.
A malformed Vansh row is now recorded as failed to parse and skipped, instead of making the whole list unreadable.
