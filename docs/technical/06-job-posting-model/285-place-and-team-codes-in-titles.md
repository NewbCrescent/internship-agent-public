**Place and team codes in titles.**
Matching's `titleNamesGraduateStudy` (packages/matching `degree-reading.ts`, `withoutPlaceAndTeamCodes`) reads a bare "MA" or "MS" in a title as a place or a team code, not a Master's level, before the graduate-only exclusion and the needs-review pursuit read the title (Track 56).
It is a state when it stands after a comma, in parentheses, or beside a dash and a stored location of the posting is in Massachusetts or Mississippi, or when a city of that state stands before it ("Boston, MA", "Jackson (MS)") or after it ("MA - Boston"), a ZIP code follows it, or a country code joins it ("US-MA-Boston").
It is a team code when the title or the posting text spells it out with two capitalized words ("Mission Systems (MS)" or "MS (Mission Systems)"), unless the first word is "Master".
A code paired with another degree ("BS/MS", "MS/PhD", "MS-PhD"), followed by "student", "students", "candidate", "degree", "program", "only", or "in", dotted ("M.S."), or spelled out ("Master's", "MBA") is still a degree, and so is "Intern, MS - Summer 2027" at a posting with no such place or team.
The graduate-only exclusion also reads undergraduate class standing (freshman, sophomore, junior, senior) as a bachelor's level inside a list of levels, so "a rising junior, rising senior, or master's student" accepts bachelor's study, while a class standing outside such a list ("senior engineers") does not count.
Such a line still gets the degree check's master's-study review, so its posting needs the candidate's review instead of failing, and the needs-review pursuit does not pursue it.
Requirement text still reads "MA" and "MS" as before.
Regressions: `testing-harness/matching/eligibility-fit.test.ts` and `review-pursuit.test.ts` (`pnpm test:matching:fast`).
