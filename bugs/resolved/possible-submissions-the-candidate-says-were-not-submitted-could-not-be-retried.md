# Possible submissions the candidate says were not submitted could not be retried

18 automatic runs (17 failed submits and one paused on Lever's hCaptcha with its approval still set) were held only as possible submissions (blocker bfce8f473a0, "a submit may have gone through: check for a receipt before any retry"), each with an absent receipt check and no confirmation.
`pnpm pipeline:retry --reopen-unsubmitted` reopens only with site evidence that the click was never taken, so it refused them (Illumio's GDPR text among them), and no path took the candidate's own verdict.
The candidate decided on 2026-11-27, answering "18 possible submissions (clicked, never confirmed; no receipt found): treat them as not submitted and retry?": "1. retry."
Fixed in Track 66: `--reopen-unsubmitted --candidate-verdict not-submitted --reason "<the candidate's words>"` with named `--run` references runs a fresh read-only receipt check first, records a receipt found and leaves that run as it is, and otherwise cancels the run, releases the hold, logs "Reopened on the candidate's verdict that it was not submitted: <reason>", and sends the job back to ready for review, where the next pass applies every current rule (`packages/agent/src/automatic-retry.ts`, `packages/agent/src/pipeline-orchestrator.ts`, `packages/agent/scripts/pipeline-retry.ts`; docs/technical/06-job-posting-model/170 and 430).
Regression: the Track 66 cases in `pnpm test:agent:retry`.
Not yet run against the real profile: the manager runs the dry run, then the reopen.

fixture: modelled (synthetic runs and an in-memory mailbox; the real runs' shapes were read read-only from the real profile on 2026-11-26)

## Refuted causes

- A code defect held the 18 runs. Evidence: Track 60's read-only triage (2026-11-27) found 0 receipts and 0 code defects for all 18.
- Site evidence could reopen them under --reopen-unsubmitted. Evidence: Illumio's GDPR text was refused before, and the real profile's 18 runs have no Greenhouse security-code mail, Ashby busy notice, or Dover Turnstile marker that unsubmittedEvidence accepts (read-only, 2026-11-26).
