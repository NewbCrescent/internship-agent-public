# Closed iCIMS and Ashby postings were reported as no application form

Found 2026-11-27 in Track 64's triage of the "No application form was found at <site>" blocker (bcdb8e318e7).
IDEMIA's two iCIMS postings (<run id>, <run id>; stopped 2026-11-21) are closed: a read-only fetch on 2026-11-27 got HTTP 410, and iCIMS's same-host content frame (`?in_iframe=1`) says "Error: The job that you were looking for either does not exist or is no longer open."
DriveWealth's Ashby posting (<run id>; stopped 2026-11-26) showed Ashby's "Page not found" and "The page you requested was not found" with no Apply-like control (stop capture 2026-11-26T15-17-35-564Z-job-no-form); on 2026-11-27 DriveWealth's whole hosted Ashby board answered 404 with no organization while Ashby's posting API still listed the job, and DriveWealth's careers page embeds a Greenhouse board listing the same posting (8039368003).
Cause: `closedPostingNotice` knew neither wording, and the orchestrator read only the top document's text, so iCIMS's notice inside its frame was never seen, and both stopped as a form that "may sit behind an Apply button".
Fix (Track 64): `closedPostingNotice` (packages/browser/src/site-navigation.ts) also reads iCIMS's wording and, on jobs.ashbyhq.com only, Ashby's not-found wording; `readClosedPostingNotice` reads the main document and same-host frames (never another host's), the application page exposes it as `postingClosedNotice`, and `startBrowserRun`'s two no-form branches use it (packages/agent/src/browser-orchestrator.ts), so an automatic run is a `PostingClosed` and the pipeline skips the job as "Posting closed" through the existing mechanism.
Regressions: the new `closedPostingNotice` cases in testing-harness/browser-worker/ats-classification.test.ts (`pnpm test:browser-worker:fast`), the iCIMS-frame and Ashby cases in testing-harness/browser-worker/run-lifecycle.integration.test.ts (`pnpm test:browser-worker:local`), and scenarios (vi) and (vii) of testing-harness/browser/site-navigation-run.ts (`xvfb-run -a pnpm test:browser:site-navigation`).
Not changed: whether discovery picks up DriveWealth's Greenhouse copy of the posting once the Ashby record is skipped (a discovery question, not verified); Ashby's page for a closed job on a board it still serves was not seen; not verified live: an automatic run on these jobs after the change.

fixture: captured 2026-11-26 (Ashby: the stop capture's page) and 2026-11-27 (iCIMS: a read-only fetch of a public closed job frame); names and hosts fictional

## Refuted causes

- DriveWealth's Ashby form was drawn after the agent stopped looking for it. Evidence: stop capture 2026-11-26T15-17-35-564Z-job-no-form shows Ashby's "Page not found" page with zero Apply-like controls, and a read-only fetch of jobs.ashbyhq.com/drivewealth on 2026-11-27 answered 404 with no organization.
- IDEMIA's 2026-11-21 stops were iCIMS's account step left unread inside its frame. Evidence: read-only fetches on 2026-11-27 of uscareers-idemia.icims.com/jobs/8707/job and /jobs/8708/job answered 410 with the frame's "either does not exist or is no longer open" notice and no Apply link.
