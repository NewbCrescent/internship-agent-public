# Sponsorship questions that mention work authorization were answered as work authorization

Found 2026-11-25 on the real workspace, in manual pass 5. ITW's "Will you
now or in the future require sponsorship for an employment visa status
(e.g., H-1B, E-3, TN, O-1, STEM OPT), or any immigration work
authorization requiring a written submission from the company to a
government agency)?" (<run id>, <run id>) was answered "Yes" from the
saved work-authorization answer, so the required "Please explain"
follow-up appeared and the run paused on it; the saved sponsorship answer
would have answered No. No submitted run had this pattern. Cause: the
mapper tested "work authorization" before the sponsorship wording, so any
question naming both became a work-authorization question. Now, when a
question names both, the one asked first decides: a sponsorship question
that mentions work authorization maps to the sponsorship answer, and "Are
you legally authorized to work … without the need for sponsorship?" stays
a work-authorization question. Regression: the sponsorship cases in
`testing-harness/agent/question-mapper.test.ts` (`pnpm test:agent`). Not
verified live: ITW's "Please explain" follow-up is assumed to show only
after a Yes.
