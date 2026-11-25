# Workday's "Bachelor's Level Degree" and "Computer sciences" options were not matched

Found 2026-11-25 on the real workspace, in pass 10. On micron.wd1
(<run id>) the college row paused on Degree and Field of Study. Micron's
degree list offers "Bachelor's Level Degree", which the general
bachelor's rule did not read because of the word "Level", and its
field-of-study search offered "Computer sciences", which the word match
did not take for "Computer Science". `chooseDegreeOption` now reads
"Bachelor's Level Degree" as a general bachelor's and picks only when
exactly one option of the same kind, or else exactly one general option,
fits; two that fit equally make the row ask. Fields of study use
`matchFieldOfStudyOption`: the same words, then the one option whose
words differ only by a plural ending (two such options ask), then the
existing containing match (`packages/domain/src/application-history.ts`,
`packages/browser/src/ats/workday-history.ts`). Regression: the new
cases in `testing-harness/domain/application-history.test.ts` (`pnpm
test:domain`) and the `?lists=micron` scenario of
`testing-harness/browser/fixture-run.ts`. Open: Micron's high-school row
read no degree options ("Options: ."); high-school rows wait on the
candidate.
