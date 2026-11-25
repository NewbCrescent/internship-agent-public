The Jobs page renders each posting as a collapsible card and lists them by fit (high to low, newest first among ties, unanalyzed last) unless `?sort=newest` is chosen; `?category=` filters by `roleTypeForTitle` (packages/domain), whose groups are Software engineering, Data and AI, Quant and finance, Security, Cloud and infrastructure, Robotics and hardware, Research, Product, Design, and Other.
The same grouping feeds outcome conversion by role.
The list shows 50 postings per page (`?page=N`, validated and clamped).
`getJobListPage` sorts lightweight summaries with fit scores read in one query, caches the ordered ids and category counts in memory per workspace connection, sort, and category (last 20 lists), and reuses them while `getJobListFingerprint` (job count, latest job update, match count, latest evaluation) is unchanged, so a new, revised, or re-analyzed posting refreshes the order.
Only the current page loads full postings, match reports, and packages; header counts come from `getJobListStats` in SQL.
`packages/jobs` `arrangePostings` and `parseJobListOptions` hold the sorting, filtering, and query validation.
