# Expired SmartRecruiters postings were reported as no application form reached

Found 2026-11-27 in Track 70's triage of the "No application form was reached at <site>" blocker (bd5ac093230).
ServiceNow's SmartRecruiters posting (<run id>, stopped 2026-11-27 04:08 UTC) showed SmartRecruiters' empty state "This job has expired" / "Sorry, this job has expired" (stop capture 2026-11-27T04-08-58-407Z-job-no-form) and stopped as "No application form was reached …".
Cause: `closedPostingNotice` did not know the wording.
Fix (Track 70): `CLOSED_POSTING` in packages/browser/src/site-navigation.ts reads "this job has expired", so the run is a `PostingClosed` and the pipeline skips the job as "Posting closed".
Regressions: the new `closedPostingNotice` case in testing-harness/browser-worker/ats-classification.test.ts (`pnpm test:browser-worker:fast`) and the SmartRecruiters case in testing-harness/browser-worker/run-lifecycle.integration.test.ts (`pnpm test:browser-worker:local`).
Not verified live: a run on this job after the change.

fixture: captured 2026-11-27 (the stop capture's text; names and host path fictional)

## Refuted causes

- ServiceNow's stop was SmartRecruiters' DataDome CAPTCHA. Evidence: stop capture 2026-11-27T04-08-58-407Z-job-no-form shows the expired-posting empty state, one hidden 1x1 frame, no challenge, and zero Apply-like controls.
