# Package answers fill select and radio fields and pre-empt question memory

`matchPackageAnswer` in `packages/browser/src/autofill-planner.ts` fills any
field whose label matches its word stems (why, interest, motivat, company;
experience, background, relevant, project, qualification; authoriz, sponsor,
start, availab, eligible, work in) with the package's prose, whatever the
field kind, so a select or radio such as "Do you have experience with
Python?" gets a fill decision carrying the relevant-experience paragraph
instead of an option, and a generic question like it never pauses, so the
candidate's answer is never asked for or saved to question memory. Found
2026-11-19 while building question memory (run H); the question-answers
integration fixtures avoid the word "experience" for that reason (the
`PYTHON_LABEL` comment). Fix direction: offer package answers only to text
and textarea fields, so such questions reach question memory or pause.

Fixed 2026-11-24: package answers are offered only to text boxes and text
areas, so a select or radio set such as "Do you have experience with Python?"
follows the usual rules (a remembered answer, a shown value, an optional skip,
or a plain pause whose answer can be remembered). Regressions: the
package-answer cases in
`testing-harness/browser-worker/recognition-planner.test.ts`
(`pnpm test:browser-worker:fast`).
