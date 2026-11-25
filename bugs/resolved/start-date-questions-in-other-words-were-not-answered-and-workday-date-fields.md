# Start-date questions in other words were not answered, and Workday date fields were not typed

Found 2026-11-25 on the real workspace, in manual pass 5. Neogen's
"earliest date you can start" question (neogen.wd5, <run id>, a Workday
date field), Neros's (<run id>) and Contoro's (<run id>, which the
candidate answered by hand) paused unmapped although the candidate's saved
available start date answers them. Cause: the mapper knew only "available
… start" and "start date"; Workday's split Month, Day and Year boxes were
read as an unknown field and, when answered, typed as one string into the
month box. The mapper now also reads "earliest/soonest … start or begin",
"when can (could, would, will) you (be able to) start or begin" and
"timeline for starting", never a full-time or after-graduation start or a
yes/no question ("Are you able to start …?"). The saved date is typed as
the field takes it: a date input YYYY-MM-DD; a text box the format its
label names (DD/MM/YYYY, YYYY-MM-DD, MM-DD-YYYY), else MM/DD/YYYY (the
form of the candidate's own answer on Contoro; earlier runs typed
YYYY-MM-DD); a number box, list, radio set or type-ahead is unchanged.
Workday's split boxes are now a date field typed month, day and year from
YYYY-MM-DD or MM/DD/YYYY; another format is a field the page would not
take, which pauses. Regression: the start-date cases in
`testing-harness/agent/question-mapper.test.ts` (`pnpm test:agent`) and
`testing-harness/browser-worker/recognition-planner.test.ts` (`pnpm
test:browser-worker:fast`), the lifecycle expectations in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts` and
`self-identification.integration.test.ts` (`pnpm
test:browser-worker:local`), and the `?gaps=1` scenario of
`testing-harness/browser/fixture-run.ts` (`xvfb-run -a pnpm
test:browser:fixture`). Not verified live: Neogen's date markup (the pause
read the field as unknown; no form-step DOM was captured).
