# Closed postings were reported as a form behind an Apply button

Found 2026-11-25 on the real workspace. Garmin's careers page
(careers.garmin.com/jobs/…, <run id>) shows "The page you are looking for
no longer exists … this job may be no longer available", and
Shive-Hattery's Paylocity posting (<run id>) now leads to "We're sorry, that
job does not exist or is not currently active."; both runs stopped saying
the form "may sit behind an Apply button". Fix: a no-form page whose text
says the posting is closed (`closedPostingNotice` in
`packages/browser/src/site-navigation.ts`) stops with "The posting page at
<host> says "<words>": the posting looks closed, so no application form was
found and nothing was filled." on automatic and candidate-started runs.
On an automatic run it is a `PostingClosed` (Track 28's class), so the
pipeline skips the job as "Posting closed" and does not retry it, as it
does for Workday's closed-posting page (`restoreDiscoveredJob` undoes the
skip). Regressions: the `closedPostingNotice` cases in
`testing-harness/browser-worker/ats-classification.test.ts`
(`pnpm test:browser-worker:fast`) and the closed-posting case and the
pipeline "Posting closed" skip case in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`
(`pnpm test:browser-worker:local`). Not changed: the automatic-retry
closed-posting text in `packages/agent/src/unsubmitted-evidence.ts`; the
jobs already stopped before this fix are not skipped retroactively.
