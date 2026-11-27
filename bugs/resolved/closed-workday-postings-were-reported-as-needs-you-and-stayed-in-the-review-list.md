# Closed Workday postings were reported as "needs you" and stayed in the review list

Found 2026-11-25 on the real workspace: five automatic runs of 2026-11-24
(Woodward <run id>, GDIT <run id>, DraftKings <run id>, CACI <run id>,
Bread Financial <run id>) stopped "No Workday application opened at <url>;
the posting may be closed". A read-only visit showed Workday's own page
"The page you are looking for doesn't exist." (`errorContainer`), and the
site's search for each requisition id found 0 jobs. Cause: entry waited
15 s for Apply only and called anything else "missing". Entry now reads
Workday's closed-posting page (its `errorContainer` with that text, twice in
a row, no Apply) as `closed`: the run stops with `PostingClosed`, an
automatic run logs "Automatic browser run found the posting closed: …",
the job gets the "Posting closed" Quick Skip (no pass starts it again;
`restoreDiscoveredJob` undoes it), and it is reported as ruled out, not as
needing the candidate. An unrelated error box is not read as closed.
Regressions: the fixture's `closed` and `other-error` modes
(`testing-harness/browser/fixtures/workday-entry.html`,
`pnpm test:browser:fixture`), the closed-posting case in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`
(`pnpm test:browser-worker:local`), and the closed-text case in
`testing-harness/browser-worker/workday.test.ts`
(`pnpm test:browser-worker:fast`). Not verified live: an automatic run on a
closed posting after the change; the five keep their old event until
retried or skipped.

## Refuted causes

- The five 2026-11-24 stops (Woodward <run id>, GDIT <run id>, DraftKings <run id>, CACI <run id>, Bread Financial <run id>) were open postings Workday's entry missed. Evidence: Track 64's read-only check on 2026-11-27: each career site's public job search for the requisition id returns 0 jobs, and each job's public CXS address answers 403.
