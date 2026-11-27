# The stop re-check ignores answers the planner takes from the profile

Run <run id> (Capital Technology Group, job <run id>, held since 2026-11-24) keeps "Are you a current college student majoring in computer science or related field?" and "Please provide a link to your LinkedIn profile." open.
The same planner answers both questions on run <run id> (job <run id>) with basis `profile`: the field-of-study rule for the first and the saved LinkedIn link for the second.
`recheckRunPauses` in `packages/agent/src/browser-orchestrator.ts` accepts only plans whose basis is `fact` or `question_answer` (docs/technical/10-candidate-memory-policy/115 documents that), so the stop re-check never marks a stop the profile answers.
The read-only dry run `pnpm questions:recheck --profile real` on 2026-11-26 reported 0 of 111 open pauses answerable by saved answers; a continue of the run would plan the form again and fill them.
That both answers would be planned on a one-field re-check form is inferred from the planner's plan on run <run id> and the re-check's basis filter, not run field by field.
Not fixed in Track 54, because the change belongs in `browser-orchestrator.ts`, which Track 42's merge round touches.
Fix direction for a later run: accept the `profile` basis for non-sensitive contact and education fields, name the source on the timeline without its value, and decide whether to record the wording.

Fixed in Track 57: `recheckRunPauses` also accepts a plan whose basis is `profile` (contact details, links, school, degree, field of study, GPA, and education dates, as a new run's planner takes them), as match kind `profile_field`; the timeline names the profile field (`your profile's LinkedIn link`), never its value; no wording is recorded for it; and on continue the field keeps the planner's profile basis and reason when today's plan gives the same answer (`packages/agent/src/pause-recheck.ts`, `packages/agent/src/browser-orchestrator.ts`; docs/technical/10-candidate-memory-policy/115).
Regression: the Track 57 case in `pnpm test:agent:aliases:local` (a held field-of-study and LinkedIn stop answered from a profile saved after the run paused, the timeline without the value, no wording recorded, and continue filling both with basis `profile`).
Read-only replay (2026-11-26): the dry run `pnpm questions:recheck --profile real` on Track 57's code reported 4 of 119 open pauses answerable (3 `profile_field`, 1 `saved_fact`), and run <run id>'s Q2 and Q4 as `profile_field`.

fixture: captured 2026-11-26 (the stored pause labels, field kinds, and options of run <run id>, replayed read-only; the test fixtures are synthetic)
