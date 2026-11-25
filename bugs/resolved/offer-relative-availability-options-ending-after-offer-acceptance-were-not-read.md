# Offer-relative availability options ending "after offer acceptance" were not read

Found 2026-11-25 on the real workspace, in pass 12. Micron's "When would
you be available if an offer was accepted?" (micron.wd1, run <run id>),
offering "Immediately after offer acceptance", "Within 1 month after offer
acceptance", "Within 2 months after offer acceptance", "More than 2 months
after offer acceptance" and "After Graduation (For current grads)", paused
unmapped. Cause: the mapper's start-date wording did not include "when
would you be available", and `startWindowDays` read only bare buckets
("Within 1 month"), so the "after offer acceptance" suffix hid every
window. Fix: the start-date wording also reads "When (can, could, would,
will) you be available?" alone, "… if (after, once, upon) an offer is
accepted", "… to join or commence" and "… for employment or this role",
never "for an interview" or "to work weekends"
(`packages/agent/src/question-mapper.ts`); `startWindowDays` strips a
trailing "after (from, following) offer acceptance" before reading the
window (`packages/domain/src/fact-options.ts`), and the existing rule picks
the matching bucket with the latest start from today and the saved
available start date; a tie between two buckets still pauses, and "After
Graduation" names no window. Regression: the offer-suffix rows and bucket
cases in `testing-harness/domain/fact-options.test.ts` (`pnpm
test:domain`), the start-date wording cases in
`testing-harness/agent/question-mapper.test.ts` (`pnpm test:agent`), and the
planner case in `testing-harness/browser-worker/consent-and-facts.test.ts`
(`pnpm test:browser-worker:fast`). Not verified live: the run also holds
questions the candidate was asked about and was not retried; its
embargoed-country citizenship question stays with the candidate.
