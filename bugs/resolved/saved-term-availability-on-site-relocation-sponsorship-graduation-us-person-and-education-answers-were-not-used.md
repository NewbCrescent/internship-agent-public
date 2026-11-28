# Saved term availability, on-site relocation, sponsorship, graduation, U.S.-person and education answers were not used

The 2026-11-28 survey of held runs found questions the candidate's saved answers or profile already settle, still waiting for the candidate.
A read-only replay of every open pause (resolveFields and planAutofill, no writes) gave each pause's cause.

fixture: captured 2026-11-28 (the stored pause labels and option lists of held runs, replayed read-only; the test fixtures are fictional)

## Terms and availability

Held: "Which internship term are you interested in?", "Spring Co-Op, Summer Internship, or Both", "Please confirm the season you are applying for.", "I confirm my availability for a Summer (May/June starts) internship".
Cause: no rule read the saved availability window for term lists or summer confirmations, the mapper left them unmapped, and question memory refused to save the candidate's answer because "interested" made it a why-interest question.
Fix: `internshipTermAnswer` and `isInternshipTermQuestion` (`packages/domain/src/term-availability.ts`), called by the planner with the window from `reusableAvailabilityWindow`; `questionSaveBlocker` no longer calls a term question why-interest.

## On-site work and relocation

Held: Integrate's and Sigma's on-site lists whose only true option is "Yes, I will relocate …", SeatGeek's "This role is located in New York City …", Strava's "(June-August)" and Addepar's "(Summer 2027)" relocation questions, Addepar's "Yes, I will arrange my own relocation …" option, and Example AI's "Are you excited to work in-office …?".
Cause: the on-site sentence rule vetoes options naming relocation, the role's own location read as "do you live nearby", any month or year held a relocation question, the own-expense matcher missed "arrange my own relocation", and "excited" was not an on-site willingness word.
Fix: `onSiteRelocationOption` (`packages/domain/src/on-site-relocation.ts`) for a resolution marked `usRelocation` (`usRelocationSettles`), `withoutCoveredTerm` in `relocationPartsHold`, `ROLE_LOCATED` and the wider `OWN` in `packages/domain/src/fact-options.ts`, and "excited" in the mapper's on-site rule.

## Sponsorship

Held: PTC's "… require, or will you in the future require, employment-based immigration sponsorship?", Best Egg's "Are you on EAD, OPT or CPT? Or need a H-1B visas transfer?", and Waymo's visa-kind list with "Not applicable".
Cause: the sponsorship pattern allowed only 30 characters between "require" and "sponsorship", the OPT rule read only "on OPT" wordings, and "Not applicable" was not a no-visa option.
Fix: the wider `SPONSORSHIP` pattern (`packages/agent/src/question-mapper.ts`), `VISA_CLASS_NOW` in `packages/agent/src/standard-question-mapper.ts`, and "not applicable", "n/a" and "na" in `NO_VISA`.

## Graduation

Held: "When do you graduate?", "What year are you expected to graduate (from University)?", "Please select the year you anticipate graduating …", "When do you expect to complete your current degree program? … MM/YYYY", and Samsara's list of bare years.
Cause: the graduation wordings missed these phrasings, and the term-option rule read a bare year only inside an open or prefixed option.
Fix: four `GRADUATION_WORDING` patterns and a bare year read as its twelve months in `graduationTermOption`.

## U.S.-person and visa status

Held: Pivotal's "Are you a US Person under ITAR …? Please select appropriate response:", Example Aerospace's "… export regulations, therefore will you state which of the following applies to you:", Hadrian's "U.S. person. This ITAR/EAR status includes …" option, Commonwealth Fusion's "Are you one of the following: a U.S. citizen, …?", and Lockheed Martin's "If yes, please indicate Visa status".
Cause: the list wording was not read as a list, "export regulations" and "visa status" were not citizenship words, the defined-option pattern allowed only "this status", and the Yes/No pattern did not read "one of the following".
Fix: `CITIZENSHIP`, the list words, and the visa-status list rule in `packages/agent/src/standard-question-mapper.ts`, `US_PERSON_DEFINED` in `packages/domain/src/export-control.ts`, and `US_PERSON_ASKED` in `packages/domain/src/standard-answers.ts`.

## Education

Held: "Current school or university:", "Current university", "What college/university do you attend?", "What is the name of your university?", Virtu's 15-option school list asking for "Other", "What is your field of study/degree program?", "What degree are you currently pursuing or have recently completed?", four GPA wordings, two GPA scale lists, and Mach's SAT list with two scales.
Cause: the school, field-of-study, degree, and GPA label patterns missed these wordings, no rule read a GPA scale list, and the SAT bucket rule saw a hit on each scale.
Fix: `SCHOOL_LABEL`, `OTHER_IF_UNLISTED` with `unlistedSchoolOption`, `DEGREE_PURSUING_LABEL`, the field-of-study contact label, `GPA_LABEL`, `GPA_SENTENCE_LABEL`, the GPA core label, and `gpaScaleDecision` in `packages/browser/src/autofill-planner.ts`, and `onTestScale` in `packages/domain/src/fact-options.ts`.

## Still paused

Clearance history, sponsorship on postings with no single stated country, office lists where several apply, commuting distance, the highest level of education completed, class standing, earliest full-time start, start-date lists with several true options, term spans outside the window, TRI's acknowledgment, clipped labels, and 500-option school lists that do not contain the school.

## Regression

`pnpm test:domain` (testing-harness/domain/term-availability-track89.test.ts), `pnpm test:agent` (testing-harness/agent/held-question-corpus-track89.test.ts), and `pnpm test:memory` (testing-harness/agent/held-questions-track89.integration.test.ts: a covered relocation question resolves, a span outside the window and a confirm-only window do not, and a dry-run recheck matches a term list, an immigration sponsorship question, and a GPA scale list while leaving a term span outside the window).

Replay (`pnpm questions:recheck --profile real`, dry run, 2026-11-28), before: open pauses: 485; would be answered by saved answers: 0; still open: 416, of which would reach AI review: 410.
After: open pauses: 485; would be answered by saved answers: 24 (saved_fact 12, standard_answer 4, profile_field 8); still open: 392, of which would reach AI review: 386.
Of 96 held runs, 19 have a matched question and 2 would have no question left.

## Refuted causes

- PTC's sponsorship question paused because "immigration" made it sensitive. Evidence: the 2026-11-28 read-only replay (resolveFields and planAutofill over every open pause) shows the pause was not skipped as sensitive; the mapper returned UNMAPPED because SPONSORSHIP allowed only 30 characters between "require" and "sponsorship".
- Tinder, Nex, OpenSesame, EQT and HRT sponsorship questions could take the posting's country. Evidence: the same replay; their postings store no location (or only "Remote"/"remote-first"), or list both the United States and the United Kingdom, so no single country is stated.
- Mach's SAT list paused because the saved score was not offered. Evidence: the list holds both a 1600-scale and a 2400-scale bucket containing the score (two hits).
- The clearance questions are settled by the saved holds/eligible answers. Evidence: each held one asks about a past, denied, revoked, expired, most-recent, or questionnaire matter that neither saved answer states.
