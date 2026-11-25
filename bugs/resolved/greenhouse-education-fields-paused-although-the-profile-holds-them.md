# Greenhouse education fields paused although the profile holds them

The same Greenhouse runs paused on School, Degree, Start/End date month and
year: nothing mapped them. Now an education block is answered from the
profile: School typed into Greenhouse's searched list (or chosen by its exact
name from a native list), Degree through `chooseDegreeOption` (a curly
"Bachelor’s" counts; never a B.S. for a B.A.), Discipline from the field of
study, the start month and year from the education start month, and the end
month and year from the run profile's graduation date (the default profile:
the global answer, else the profile's date; the transcript profile: only its
2029 answer, never 2028). Anything missing pauses when required. The
application record now reports only a full-date graduation answer as
"answered on the form", never an End date month or year with the same fact
basis. Regressions: `recognition-planner.test.ts`,
`run-lifecycle.integration.test.ts` ("education block": 2028 default, 2029
transcript, pause without a 2029 answer), `application-history.test.ts`,
`application-record.integration.test.ts`, and the Greenhouse scenario of
`pnpm test:browser:greenhouse`. The date rule needs Greenhouse's education
ids (`start-month--0`, `end-year--0`, …): its employment block repeats the
same "Start date month" labels under `start-date-month--0` and the like, and
is never filled from education data (optional: left empty; required: a
pause; regressions in `recognition-planner.test.ts` and the fixture's
employment block).
