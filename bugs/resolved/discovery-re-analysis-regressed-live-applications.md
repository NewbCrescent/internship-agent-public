# Discovery re-analysis regressed live applications

Re-pasting a batch re-ran `evaluateAndPersistMatch` over every ingested
posting, including ones already submitted or interviewing. Analysis rewrites
the posting status, so a live application was dragged back to an early stage
and re-prepared. Found by lifecycle simulation 2026-09-22: two submitted
postings reverted after a re-paste.

Fixed: the discovery orchestrator skips ingestion, analysis, and promotion for
postings past the approval gate (`APPROVED` through `WITHDRAWN`) and reports
them as `skippedJobIds`. The repository also rechecks status under its write
lock if an application becomes live during asynchronous classification.
Regression: `leaves live applications untouched when their text is pasted
again` in `testing-harness/jobs/discovery.integration.test.ts` uses revised
posting text and verifies that the current snapshot and snapshot count stay
unchanged. `protects a posting that becomes live while classification is pending`
in `testing-harness/jobs/ingestion.integration.test.ts` covers the write-lock
guard.
