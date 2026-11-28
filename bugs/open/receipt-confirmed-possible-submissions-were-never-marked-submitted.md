# Receipt-confirmed possible submissions were never marked submitted

A trusted receipt for a possible submission resolved its hold but left the run failed and the job APPLYING (Track 80's open item 1).
Track 60 kept the application status unchanged by design, so a policy submit that Track 80 held as a possible submission (`SubmissionUnverified`) never counted as submitted even after the employer's receipt arrived.
The receipt check ran only when new mail arrived (the Gmail watcher) or by hand (`pnpm mail:scan --receipt <run>`).
The pipeline pass reported each `SubmissionUnverified` under errors as "Automatic submission failed: …", and the daily digest read a run that `NO_APPLICATION_CONTENT_BLOCKER` holds as `ready, say "send <company>"`.

Fix (Track 85): `recordApplicationReceipt` (`packages/db/src/application-hold-repository.ts`) marks the run submitted with the receipt as its confirmation and the job SUBMITTED when it resolves a possible-submission hold, and `promoteConfirmedReceiptRuns` applies receipts recorded earlier.
Every pass runs `checkPendingSubmissionReceipts` (`packages/agent/src/submission-receipts.ts`, called from `packages/agent/scripts/pipeline-pass.ts`) for each open possible submission from the last 14 days, read-only on the mailbox.
`packages/agent/src/pipeline-orchestrator.ts` reports a `SubmissionUnverified` under `possibleSubmissions` with the note `POSSIBLE_SUBMISSION_NOTE`, which the pass log, `pass-notice.ts`, `daily-digest.ts`, and `pipeline-scoreboard.ts` show as waiting for a receipt; the digest reads a no-content run as `held, not ready: …`.
Details: `docs/technical/06-job-posting-model/435-receipt-confirmed-submissions.md`.

Regressions: the Track 85 cases in `pnpm test:agent:retry`, `pnpm test:agent:pass`, `pnpm test:agent:notify`, `pnpm test:agent:digest`, `pnpm test:agent:scoreboard`, `pnpm test:browser-worker:local`, and `pnpm test:domain`; each fails on the old code.

fixture: modelled (an in-memory mailbox, synthetic runs, and fake pages)

Stays open until a live receipt moves a real possible submission to SUBMITTED.
