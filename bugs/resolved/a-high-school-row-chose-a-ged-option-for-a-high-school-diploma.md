# A high-school row chose a GED option for a high-school diploma

Found 2026-11-25 on the real workspace, in manual pass 8. On Rockwell
(<run id>) the high-school row chose "GED (High School Equivalent)" for
"High School Diploma", and neogen.wd5 and zoll.wd5 showed "GED" on that
row. Cause: `chooseDegreeOption` took the first option naming high
school, secondary, or GED. A high-school row now picks a high-school
diploma option, then a plain high-school option, then a combined
diploma-or-equivalent option ("High School Diploma/GED", "High School or
Equivalent"); a GED or equivalency option alone is never picked, and the
row then asks with the offered options
(`packages/domain/src/application-history.ts`). Regression: the new
`chooseDegreeOption` case in
`testing-harness/domain/application-history.test.ts` (`pnpm
test:domain`) and the GED-first degree list in the `?widgets=real`
scenario of `testing-harness/browser/fixture-run.ts`.
