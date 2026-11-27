# iCIMS account stops held before a fix could not be requeued

Found on 2026-11-27 (Track 69): the six "the account step stopped (a page the agent does not recognize)" jobs (Example Consultants, Bissell, General Dynamics Mission Systems, Mapwise Technologies, IDEMIA, and Garmin; stops of 2026-11-21 and 2026-11-22, before the content-frame fix) carry manager-owned job-level `account-stop` holds.
`pnpm pipeline:retry --job <ref> --verified-hold` refused them, since it took only `automation-fault`, and each job's older "Automatic browser run needs you:" stop keeps `stoppedSinceRetry` true, so only the all-jobs `pnpm pipeline:run --retry-stopped` could retry them.
Fix: `verifiedJobHold` (`packages/agent/src/automatic-retry.ts`) also releases a manager-owned job-level `account-stop` hold under every other check (ready for review, no live run, no submit attempt, exact revision, matching observation, recheck not reused); the host's own account hold stays until it is cleared.
Regression: "requeues a job-level iCIMS account stop the same way" in `testing-harness/agent/automatic-retry.integration.test.ts` (`pnpm test:agent:retry`).

fixture: captured 2026-11-27 (application_holds rows and events of the real workspace, read-only); names and hosts in the test fictional

## Refuted causes

- The six stops are an account screen the agent still does not recognize. Evidence: the six were saved 2026-11-21 (five) and 2026-11-22 (Garmin <run id>), before <run id> (2026-11-24) read iCIMS's content frame; their screenshots show the email-first step inside the frame; since then iCIMS hosts read that step and stopped at hCaptcha or a named consent (consent logged at four hosts on 2026-11-25 and 2026-11-26), except blank login pages on careers-garmin.icims.com at about 07:35 UTC on 2026-11-25, 2026-11-26 and 2026-11-27 (empty text, a logo-only screenshot), reached only because career-site postings ignored the host's hold (postings-on-employer-career-sites-reopened-a-held-icims-host-on-every-pass.md).
- iCIMS account creation is not turned on for the real workspace. Evidence: the three 'does not create iCIMS accounts' stops are from 2026-11-20, before <run id> added account creation, and iCIMS email steps were submitted under the opt-in on 2026-11-25 and 2026-11-26.
