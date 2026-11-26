# Technical research internships were ruled out by the role rule

Found 2026-11-26 when newly found boards listed research internships that the target rules skipped with "Role: the title names no software or adjacent engineering work."
The candidate decided on 2026-11-26: "I am fine with research summer", and added "as long as it is payed".
Cause: `judgeRole` (packages/domain `application-target.ts`) had no research term, and its exclusion list named quantitative research, research scientist, and any PhD or Master's mention, so "Research Intern (BS/MS/PhD)" and "Quantitative Research Intern" skipped; matching's `titleNamesGraduateStudy` (packages/matching `eligibility.ts`) also read "BS/MS/PhD" as a graduate-only title.
Role: `judgeRole` now counts a research title unless it names non-technical research without a computing word, and skips a graduate-level title (PhD, doctoral, doctorate, Master's, MBA, research scientist) only when it names no bachelor's level.
Pay: `judgePay` also treats credit-only, credit in lieu of pay, volunteer, uncompensated, without-pay, and stipend-not-provided wording as unpaid for every internship, and a research title gets "Pay: research internship is unpaid or for credit."; a research posting silent on pay still counts.
Matching: `titleNamesGraduateStudy` no longer flags a title that also names a bachelor's level; graduate-level requirements still fail matching and never reach auto-submit.
Read-only counts on the real workspace (summer-2027 target, 627 stored postings): 227 skipped by the role rule, 179 of them only by it; the new rule accepts 8 of those 179, all research titles (4 QUALIFIED, 2 ANALYZING, 2 NOT_QUALIFIED in matching), and 12 role-only research titles stay skipped.
No posting the old rule accepted is skipped by the new one.
Of the 8 newly accepted, 5 state no pay and 3 state pay; of all 40 stored research titles, 32 state no pay, 8 state pay, and none is unpaid or credit-only; the new pay wording matches no stored posting.
The matching title change affects 1 stored posting, which keeps its stored NOT_QUALIFIED verdict until it is re-analyzed.
Regressions: `testing-harness/domain/application-target.test.ts` (`pnpm test:domain`), and `testing-harness/matching/eligibility-fit.test.ts` and `review-pursuit.test.ts` (`pnpm test:matching:fast`).
fixture: modelled (fictional titles and postings modelled on board titles)
