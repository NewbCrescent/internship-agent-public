# State codes in titles were read as a Master's level

Found 2026-11-26 by Track 53's read-only check of the real workspace: Lutron's "Summer 2027 - Software Engineering Intern - Boston, MA" and two other Boston, MA titles failed the graduate-only exclusion with "The internship title targets a Master's or PhD candidate".
Cause: matching's MASTER_LEVEL pattern (packages/matching `eligibility.ts`) reads `m\.?\s*a\.?` and `m\.?\s*s\.?` as Master's levels, so the state code in "Boston, MA" (and an "MS" that is Mississippi or a team code) read as a degree in `titleNamesGraduateStudy`.
The same postings, and ten Lutron postings in other cities, also failed the hard line "You are a rising junior, rising senior, or master's student at the start of the internship", because `acceptsBachelorLevel` did not read class standing as a bachelor's level.
Fix: `withoutPlaceAndTeamCodes` (packages/matching `degree-reading.ts`) blanks an MA or MS that is a state (a stored location in that state, a city of it before or after, a ZIP code, or a joined country code) or a spelled-out team code before the title is read, and `acceptsBachelorLevel` reads freshman, sophomore, junior, and senior inside a list of levels as a bachelor's level.
MS/PhD, BS/MS, M.S., "MS students", Master's, and MBA still read as graduate study, and "Intern, MS - Summer 2027" with no place or team context stays graduate-level.
Stored verdicts do not change by themselves; `pnpm matches:reevaluate` re-runs them (Track 56).
Read-only counts on the real workspace (2026-11-26): 39 stored postings carried the title finding, 6 stored titles have a bare MA or MS (3 Boston, MA titles, one Mississippi-free "…, MS - Summer 2027", one "(BS/MS)" already read correctly by the current code, one "(MS/PhD)"), and 13 Lutron postings carry the class-standing line.
Regressions: `testing-harness/matching/eligibility-fit.test.ts` and `review-pursuit.test.ts` (`pnpm test:matching:fast`), and `testing-harness/matching/match-reevaluation.integration.test.ts` (`pnpm test:matching:reevaluate`).
fixture: modelled (fictional titles, locations, and requirement lines modelled on stored board titles)

## Refuted causes

- The Boston, MA postings were NOT_QUALIFIED only because the title's "MA" read as a Master's level. Evidence: their stored findings on the real workspace (read-only, 2026-11-26) also fail the hard line "You are a rising junior, rising senior, or master's student at the start of the internship" as graduate-only, and the ten Lutron postings in other cities fail on that line alone; the title fix alone changed none of their verdicts.
