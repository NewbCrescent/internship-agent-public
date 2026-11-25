# An automatic approval that never reached the site used the day's auto-submit slot

On 2026-11-20 the real workspace's daily cap
(`INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP=1`) was used by the Tidewave attempt
(10:08Z): it was approved automatically and clicked, but Greenhouse then
asked for an emailed security code, so nothing was submitted, and no real
application could go out that day. The cap counted every "Submission
approved automatically by your auto-submit policy" event since local
midnight. Now `automaticSubmissionsSince` (`pipeline-orchestrator.ts`) ties
each approval to its job's latest run created at or before it and releases
it only when that run is known not to have reached the site: its approval
was withdrawn (field errors after the click, a challenge, a missing security
code: the run is back with the candidate) or the failed submit was reopened
with `--reopen-unsubmitted` before the job's next run began. A submitted,
submitting, failed, cancelled, or still-approved run, or an approval whose
run cannot be found, still counts. Regression: the "daily auto-submit cap"
cases in `automatic-retry.integration.test.ts` (`pnpm test:agent:retry`).
