# The AI pause review prompt did not say past dates are not availability

On the real profile's pass 23 (2026-11-26), the AI pause review gave saved_answer verdicts on Coinbase's work-history block ("Start date month", "Start date year", "End date month", "End date year"), matching a previous job's dates to the candidate's availability dates; the guardrails refused all four (no matching option, field kind), as Track 54 found.
Cause: the review's instructions did not say that the dates of a past job, internship, or education entry are history, not availability, so nothing told the model that the two kinds of date never answer each other.
Fixed in Track 57: `PAUSE_REVIEW_INSTRUCTIONS` (`packages/agent/src/pause-review.ts`) now states that the start or end month or year of a past job, internship, or education entry is history, not availability, that an available start or end date never answers it, and that a history date never answers an availability question (docs/technical/10-candidate-memory-policy/117).
Regression: the Track 57 case in `pnpm test:agent:pause-review:local` (the instruction text and the instructions sent to a fake model).
It stays open until a live pass with a configured model shows no saved_answer verdict matching availability dates to a work-history or education date field.

fixture: modelled
