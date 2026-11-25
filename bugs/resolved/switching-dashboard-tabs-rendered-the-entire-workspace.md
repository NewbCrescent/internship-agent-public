# Switching dashboard tabs rendered the entire workspace

Overview and Applications materialized all 2,619 posting summaries; Review
hydrated all 926 entries and their resume histories. Warm local development
requests took about 1.5–2.4 seconds and returned 2–3 MB. Pipeline counts repeated
the summary projection, and location/latest-resume lookups lacked indexes.

Fixed with bounded Overview reads, paginated Applications/Review queries,
aggregate counts, latest-only resume comparisons, read indexes, and loading
boundaries. Global counts and Refresh all retain workspace-wide scope; batch
checkboxes explicitly cover the visible page. Regressions: `bounded dashboard
reads` in `job-list.integration.test.ts` and `large lists stay bounded when
navigating tabs and pages` in `review-queue.spec.ts`. Jobs still renders its
existing 50 full cards per page; its payload has not been reduced by this fix.
