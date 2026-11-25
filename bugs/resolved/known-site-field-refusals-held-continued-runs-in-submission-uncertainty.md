# Known site field refusals held continued runs in submission uncertainty

After a candidate answered an invalid field pause and continued a browser run,
the run returned to `awaiting-approval` with approval cleared (`submissionApprovedAt: null`).
However, `explainsPriorSubmit` and `receiptInvestigation` only recognized
`field-errors` and `verification-code`, treating any site refusal captured as
`outcome: "refused"` with `invalidFields` as a conflicting uncertainty capture,
which routed the run to manager-owned `possible-submission` instead of candidate-owned
`approval`. Now `isFieldRefusal` recognizes both `field-errors` and `refused` with
non-empty `invalidFields`, allowing continued runs to proceed to approval while
preserving uncertainty holds for genuine ambiguous submissions without field lists.
Regressions: continued run hold routing tests in
`testing-harness/agent/submit-evidence.integration.test.ts` (`pnpm test:agent:evidence`).
