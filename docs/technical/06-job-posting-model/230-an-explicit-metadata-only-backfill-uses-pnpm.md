An explicit metadata-only backfill uses `pnpm exec tsx --env-file-if-exists=.env packages/agent/scripts/backfill-posting-dates.ts --profile real --limit 100 --offset 0`.
It holds the workspace pipeline lock, reads at most 100 postings or five minutes per pass, uses at most four concurrent requests spaced by at least 350 ms per host, reuses bounded allowlisted resolvers and Ashby board responses, and reports `nextOffset` for the next pass.
It never calls a model, prepares packages, changes job status, or opens an authenticated browser.
Existing dates are retained; unavailable or unsupported dates remain unknown.
