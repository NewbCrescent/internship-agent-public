# Held self-identification stops were never settled by the stop re-check

Found 2026-11-28 (Track 90's survey of held questions; the candidate: "I feel like these questions were already answered, find out why they are not beign automstically answered", and "cant this be fixed permenantly?").
Run ids are the held runs' first eight characters; no saved value, and no per-run outcome that would imply one, is recorded here.

Cause:
1. The stop re-check (`recheckRunPauses` in `packages/agent/src/browser-orchestrator.ts`) skipped every sensitive pause, so a run that paused on a self-identification question before the matcher could settle it (Lockheed Martin <run id> and <run id>, Sierra <run id>, Strava <run id> and <run id>, Tinder <run id> and <run id>, Toyota Research <run id> and <run id>, all created before Track 82) kept that stop open after Tracks 82 and 90 taught the matcher to settle it.
2. Only a continue planned such a stop again, but Track 78's pass continues only runs with no open question, and `pnpm pipeline:retry --held` refuses a run with any answered question, so nothing ever continued these runs.

Fix (Track 91): the stop re-check settles a sensitive open stop only through the planner's deterministic self-identification path (`resolveFields`' `SELF_IDENTIFIED` resolution, chosen or checked by `planAutofill` from its own saved key; `sensitiveStopSettlement` in `packages/agent/src/pause-recheck.ts`), or, for a pronoun question an older run recorded as sensitive, the saved pronouns answer through the question mapper.
It never uses the AI review, question memory, or a recorded wording for such a stop, records no wording, marks the pause answered with no answer, and logs `Answer to "<label>" settled by your saved voluntary self-identification answer; it no longer waits for you.`, never the value or its category.
`continueBrowserRun` plans such a stop again on the page from the saved answers, and opens it again when today's plan no longer settles it.
A run the pipeline started that is left with no open question is then continued by the next pass (Track 78).
Regressions: "sensitive stops and the saved self-identification answers (Track 91, fictional answers)" and the updated sensitive-stop test in `testing-harness/agent/question-aliases.integration.test.ts` (with non-identity wordings, a page failure, and an unsaved category, which stay open and write nothing), and the Track 91 test in `testing-harness/agent/continued-auto-submit.integration.test.ts` (settled, continued, and submitted by the pass).

Read-only replay over the real held runs (`pnpm questions:recheck --profile real`, 2026-11-28, old and new code back to back): before, 666 open pauses, 0 answered by saved answers, 94 skipped, 572 still open; after, 666 open pauses, 10 settled from the saved self-identification answers, 52 skipped, 604 still open.

Not fixed here:
- Every listed run still holds other open questions, so none is continued yet.
- Sierra <run id>'s and Strava <run id>'s and <run id>'s sensitive checkbox stops are page failures ("The agent could not fill …"), which the re-check never looks at.
- Strava's "What are your personal gender pronouns?" is held by the question mapper's protected-question rule (it names gender), although the field is no longer a demographic one.
- A single sensitive checkbox (a veteran classification box, Oracle's Hispanic or Latino box) is never settled by the re-check in either direction, since a pause record does not keep whether the field was optional and settling only one direction would show the saved answer; a continue that reads the page settles it.

fixture: modelled (held pauses rebuilt from the shape of the held runs' recorded pauses; fictional saved answers)

Resolved once a pass continues a held run whose last open question the re-check settled this way on a live form.

## Refuted causes
- The saved self-identification answers were missing or not saved for automatic reuse. Evidence: the read-only replay of 2026-11-28 settles 10 held self-identification stops from the saved answers with Track 91's re-check (counts above).
