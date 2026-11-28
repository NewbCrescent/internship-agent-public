# Held questions with saved answers were not answered for new wordings and option shapes

fixture: captured 2026-11-27 (stored labels and options of the held runs, replayed read-only; the tests use fictional names and values)

On 2026-11-27 the 163 paused runs held 706 open questions, and many asked what the candidate had already saved (graduation date, relocation, on-site work, citizenship and sponsorship, how heard, 18 or older, school and degree, GPA, SAT, start date, links).
The read-only re-check (`pnpm questions:recheck --profile real`, dry run) found 0 of them answerable: 104 were not eligible (53 sensitive, 27 page failures, 16 unlabeled-control faults, 5 uploads, 2 safeguards, 1 Workday history pause), and of the 602 eligible ones the mapper returned UNMAPPED for 476 and AMBIGUOUS for 56, while 47 it resolved still paused because no option rule fitted.
The causes were mapper wording gaps (graduation, start and end dates, the Workday petition and "sponsored for a work visa" wordings, "first hear", office wordings, the United Kingdom and Hong Kong, undergraduate-program enrollment, SAT and ACT), planner label gaps (contact labels with a trailing colon, typos, or a text area, portfolio, legal name, GPA wordings, degree-level questions), option-shape gaps (one-decimal, "out of 4.0", and threshold GPA lists, new graduation term shapes, Yes/No graduation comparisons, closest dates, sentence Yes/No options, visa-class "None", U.S.-person Yes/No, score buckets, checkbox groups having no option rules), and postings with no country in their locations.
Round 2 (Track 79 recheck): a U.S.-citizen requirement takes Yes only from a saved citizen or national status, or a saved category the question itself names; a permanent resident, refugee, asylee, or protected individual otherwise pauses.

## Fix (Track 79)

The mapper, planner, and option rules read these wordings and shapes deterministically, each picking exactly one option or pausing (docs/technical/10-candidate-memory-policy/118).
Checkbox groups get the list option rules; the planner's GPA rule takes a one-decimal option truncated, never rounded up, and the highest threshold met.
A posting with no country in its locations takes the title's one exact country piece.
Two canonical score keys (`sat_score`, `act_score`) and `pnpm profile:answers --promote <id> --key <key> [--dry-run]` let a saved score answer become the fact every SAT wording reuses, with the candidate's answer as its provenance.
The GPA needs no promotion: the profile GPA is already the source the planner reads.

Regressions: `testing-harness/domain/fact-options.test.ts`, `testing-harness/agent/question-mapper.test.ts`, `testing-harness/agent/held-question-corpus.test.ts` (the held wordings and option lists with fictional names and values), `testing-harness/browser-worker/recognition-planner.test.ts`, and `testing-harness/agent/question-answers.integration.test.ts` (`--promote`).

Replay (read-only dry run against the real profile): before, 0 of 706 open questions would be answered; after, 99 of 720 (the held runs had grown), across 59 runs (saved facts 51, standard answers 5, profile fields 43), about 29 graduation, 21 contact and links, 11 degree level, 8 sponsorship and visa, 7 GPA, 6 start and end dates, 5 on-site, 5 U.S.-person, 3 previous employment or relatives, 2 how heard, 1 age, 1 authorization.

## Not fixed

- SAT questions now map to `sat_score` and wait as recognized questions with no saved fact until the saved "SAT or ACT Score" answer is promoted (`pnpm profile:answers --profile real --promote <id> --key sat_score --dry-run`, then without `--dry-run`); question memory is read only for unmapped questions.
- Academic standing, class year, highest level of education completed when both "High School Diploma" and "Some College" are offered, internship term choices, county, full permanent addresses, education month and year selects, availability for a stated date window, and "work out of <city>" with no office word still pause; they need a saved answer or a candidate decision.
- A question naming Hong Kong now asks for a Hong Kong authorization answer, which is not saved.
- Postings with empty locations and no country in their titles still leave authorization and sponsorship questions ambiguous until their locations are backfilled.
- An on-site list offering "Yes" beside "Yes, but require relocation" takes the plain "Yes" from a saved on-site Yes, as a list naming the office did before this fix.
- The 27 "The agent could not fill" pauses and the 16 unlabeled-control faults are executor issues, not answer gaps.

## Refuted causes

- The saved answers were missing. Evidence: read-only key listing 2026-11-27 (graduation_date, how_heard, work_arrangement, requires_sponsorship country:US, age_18_or_older, us_person_export_controls present; profile gpa, linkedinUrl, githubUrl, degree present).
- The stop re-check did not cover the held runs. Evidence: the 2026-11-27 dry run read all 706 open pauses with no unreadable run; 602 were planned again and 0 matched because the mapper returned UNMAPPED for 476 and the planner's option rules held 47 RESOLVED ones.
