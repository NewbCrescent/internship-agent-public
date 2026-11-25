# Answering a held run reported "remembered" backwards

`answerRunPause` returned `remembered: resolution.status === "ANSWERED_ONCE"`,
which is true when nothing was stored (remember off) and false when a fact was
stored, so the run panel said "Answer recorded and remembered" for answers it
had not kept and the opposite for answers it had. Found 2026-11-19 (run H).
Now `remembered` is true exactly when an answer was saved to candidate facts
or question memory, and the result carries the outcome and its reason.
Regression: "reports remembered only when a fact was stored" in
`testing-harness/agent/question-answers.integration.test.ts`
(`pnpm test:agent:answers:local`).
