Overview reads only the 20 newest posting summaries.
Applications and Review use validated, clamped `?page=N` parameters with 50 entries per page and stable id tie-breakers.
Application status filters run before pagination; aggregate pipeline and outcome totals remain workspace-wide.
Review defaults to fit high-to-low (unscored last, newest import then id for ties) and offers Newest by import time.
`?sort=fit|newest&days=N` combines sort and an employer publication age of 1–365 days before its SQL count and pagination; the rolling window includes both boundaries and excludes unknown/future dates.
Page links preserve these options; changing a control resets to page 1.
Cards show stored fit scores and employer dates, and an empty filtered result is distinguished from an empty queue.
Both Jobs and Review also take `?country=XX|none&minPay=N`, validated in `packages/domain/src/posting-filters.ts`: a posting matches each country it states, and minimum pay compares USD per hour against the top of the stated range, converting monthly and yearly pay at 2,080 hours a year in one SQL expression (`packages/db/src/posting-filter-sql.ts`) shared by the Review query and the Jobs summaries.
Postings without a stated country or comparable USD pay are hidden by those filters and counted in the toolbar; "Not stated" lists the countryless ones.
Country labels are computed on the server.
The Jobs pager keeps the window position and shows a pending state instead of scrolling to the top.
Reads do not recompute fit.
Review compares only the visible page's latest frozen resumes.
Batch checkbox selections are page-specific; **Refresh all** resolves changed applications across the entire queue, including entries hidden by age filters, in its Server Action, retaining the existing approval and submission safeguards.
With `INTERNSHIP_AGENT_MANUAL_ONLY=1`, the Review Queue becomes a manual checklist: package approval, browser runs, and submit approvals are hidden and refused at their entry seams (nothing is removed; unset the flag to restore the AI flow), and checking an entry off (one click and a confirmation on its card) records a terminal candidate-applied `SUBMITTED` with no undo.
