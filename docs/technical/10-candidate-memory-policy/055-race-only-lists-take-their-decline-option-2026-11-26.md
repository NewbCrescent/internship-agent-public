**Race-only lists (2026-11-26, Track 55).**
Some forms ask race on its own, with no Hispanic or Latino option (a Rippling form's "Please identify your race"), so a saved race or ethnicity answer that such a list does not offer leaves the question without a matching option.
The candidate decided, 2026-11-26: "Choose not to disclose".
When the label names race or racial and no ethnicity, Hispanic, or Latino wording, no offered option matches the saved race or ethnicity answer, and the list offers exactly one decline option, `matchSelfIdentificationOption` (packages/browser `src/ats/self-identification.ts`) chooses that decline option and marks it `race_only_decline`.
A saved answer that an option matches still takes that option, several matches still pause, and a list with no decline option or more than one, a combined race-or-ethnicity question, a Hispanic/Latino yes-no question, an unknown saved value, and no saved answer all pause as before.
Every run path reaches it through `resolveFields` in packages/agent `src/browser-orchestrator.ts`, including Workday steps, continued runs, and the stop re-check.
The decision's reason is only "Answered a race-only self-identification question with its decline option (the candidate's rule, 2026-11-26).", nothing new is stored, and the saved value never reaches a model, logs, the timeline, notices, or reports.
The choice is a fill, not a pause, so it does not hold auto-submit.
Regressions: the race-only cases in `pnpm test:browser-worker:fast` and the race-only runs in `pnpm test:browser-worker:local`.
