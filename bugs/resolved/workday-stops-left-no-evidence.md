# Workday stops left no evidence

The account-step holds and the Granite pause above kept nothing of what Workday
showed. Now every account-step hold and every step Workday would not save
saves local evidence while the page is open (`saveWorkdayEvidenceQuietly`;
outcomes `workday-account` and `workday-errors`; folder 700, files 600;
screenshot, redacted visible text, query-stripped URL, Workday's errors with
their labels, and the agent's detail). An account-step stop has no run yet,
so its folder is the job's (`<time>-workday-account`, `runId` null) and the
account email and password are replaced by "[redacted]"; `pnpm run:evidence
--job <ref>` shows a job's evidence. Regressions:
`submit-evidence.integration.test.ts` (`pnpm test:agent:evidence`) and the
Workday evidence cases in `run-lifecycle.integration.test.ts`.
