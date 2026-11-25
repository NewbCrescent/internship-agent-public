# Sensitive, blocked, and ambiguous questions could not be answered for a run

Answering a held run's demographic (EEO) pause, a pause the mapper blocks
(protected wording or an attestation), or an ambiguous catalog question threw
"That answer did not resolve": the pause's question was mapped, and a
`REQUIRES_CONFIRMATION` (blocked or protected) or `AMBIGUOUS` result was not
among the usable ones, so the answer was refused and the Discord notice's
"answered for this application only" questions had no way to be answered.
Found 2026-11-19 (run H). Now those answers are recorded for that run only,
never stored, and the timeline records why. Regression: "records attestation,
protected, sensitive, and ambiguous answers once instead of refusing them" in
`testing-harness/agent/question-answers.integration.test.ts`.
