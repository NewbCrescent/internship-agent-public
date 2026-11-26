# The stop re-check ignores answers the planner takes from the profile

Run <run id> (Capital Technology Group, job <run id>, held since 2026-11-24) keeps "Are you a current college student majoring in computer science or related field?" and "Please provide a link to your LinkedIn profile." open.
The same planner answers both questions on run <run id> (job <run id>) with basis `profile`: the field-of-study rule for the first and the saved LinkedIn link for the second.
`recheckRunPauses` in `packages/agent/src/browser-orchestrator.ts` accepts only plans whose basis is `fact` or `question_answer` (docs/technical/10-candidate-memory-policy/115 documents that), so the stop re-check never marks a stop the profile answers.
The read-only dry run `pnpm questions:recheck --profile real` on 2026-11-26 reported 0 of 111 open pauses answerable by saved answers; a continue of the run would plan the form again and fill them.
That both answers would be planned on a one-field re-check form is inferred from the planner's plan on run <run id> and the re-check's basis filter, not run field by field.
Not fixed in Track 54, because the change belongs in `browser-orchestrator.ts`, which Track 42's merge round touches.
Fix direction for a later run: accept the `profile` basis for non-sensitive contact and education fields, name the source on the timeline without its value, and decide whether to record the wording.

fixture: none yet
