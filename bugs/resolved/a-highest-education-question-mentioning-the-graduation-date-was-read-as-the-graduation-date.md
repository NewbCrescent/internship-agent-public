# A highest-education question mentioning the graduation date was read as the graduation date

Granite Dynamics' Workday question "4. If hired by Leidos, we will verify your most recent graduation date and the highest degree or diploma received. What is the highest level of education you've received?" (run <run id>, Q4, degree-level options) was held as "saved fact not used: graduation_date" (pass 25 blocker b0ef4b6d2aa).
Cause: the graduation-date mapping rule matched "graduation date" in the question's preamble.
Fixed in Track 57: a question about the highest education, degree, or diploma received is not a graduation-date question (`packages/agent/src/question-mapper.ts`); it now waits as a plain candidate question, and the highest education received is never inferred.
Regression: the Track 57 case in `pnpm test:agent` (mapping).
Read-only replay (2026-11-26, `pnpm questions:recheck --profile real`, dry run): the question is no longer matched to the graduation date and stays open for the candidate.

fixture: captured 2026-11-26 (the stored pause label of run <run id>, replayed read-only; the test fixture is fictional)
