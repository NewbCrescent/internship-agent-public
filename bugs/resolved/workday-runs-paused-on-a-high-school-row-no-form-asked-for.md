# Workday runs paused on a high-school row no form asked for

Found 2026-11-25 on the real workspace: Workday runs at Rockwell
Automation (two), PTC, Illinois Tool Works (two), Sierra Space,
Activision Blizzard, enGen and Granite Dynamics paused on My Experience's
high-school education row (`history:education:<high school>:degree`,
`:field` and `:school`). Workday's Degree lists often offer no
high-school option, Field of Study has nothing that fits a high school,
and some school lists lack the school. Cause: `planApplicationHistory`
always listed the high school after the college, and
`fillWorkdayHistory` added every listed row to the Education section.
Decision: the candidate's rule of 2026-11-26 lists only the university
by default and enters the high school only where a form asks for high
school (a high-school, secondary-school, or GED question) or for every
school attended. Fix: `educationRowsForSection`, `asksForHighSchool`,
`asksForAllSchools` and `schoolsAttendedLines`
(`packages/domain/src/application-history.ts`); Workday's Education
section takes its rows by its own label
(`packages/browser/src/ats/workday-history.ts`); the planner's
school-question rule answers high-school and every-school questions and
never gives a high-school question the college's graduation date
(`packages/browser/src/autofill-planner.ts`, wired in
`packages/agent/src/browser-orchestrator.ts` and
`packages/agent/src/workday-run.ts`); migration 0035 and
`pnpm profile:facts`' `highSchool` file hold the high school's place.
Regressions: the main Workday walk in
`testing-harness/browser/fixture-run.ts` (`pnpm test:browser:fixture`)
enters the college row only; the "high-school and every-school
questions" planner tests in
`testing-harness/browser-worker/recognition-planner.test.ts`; the
education-block run test in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`.
Open: the held runs need the manager's re-run under the standing
authorization.
