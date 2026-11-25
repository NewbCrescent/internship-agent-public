# F-1 OPT questions were not answered from the saved citizenship answers

Found 2026-11-25 on the real workspace, in pass 13. KLA's "Are you
currently in a period of Optional Practical Training…" and "Are you
eligible for a 24-month OPT extension…" (employer-i.wd1, run <run id>) paused
unmapped. Cause: no rule read OPT questions, although Optional Practical
Training exists only for F-1 students, which a U.S. citizen, national or
permanent resident cannot be. Fix: a derived key
`f1_optional_practical_training` (`packages/domain/src/candidate-facts.ts`,
`packages/domain/src/standard-answers.ts`; never stored, like the other
derived standard answers, and excluded from `pnpm profile:facts` in
`packages/agent/src/profile-facts.ts`). The standard mapper
(`packages/agent/src/standard-question-mapper.ts`) maps only Yes/No
"currently on (in a period of) OPT" and "eligible for the (STEM) OPT
extension" questions, the acronym only in capitals and never "opt in" or
"opt-out"; another OPT question (a date, a future need, a negation, or one
combined with citizenship) holds. The resolver
(`packages/agent/src/standard-answers.ts`) answers No only from a saved Yes
to U.S. citizenship or a saved citizen/national or permanent-resident
export-control status; anything else asks the candidate, and it never
answers Yes. Sponsorship questions that mention STEM OPT still map to
sponsorship. Regression: the OPT rows in
`testing-harness/agent/question-mapper.test.ts` (`pnpm test:agent`), the
derived-key case in `testing-harness/domain/standard-answers.test.ts`
(`pnpm test:domain`), and the OPT cases in
`testing-harness/agent/memory-service.integration.test.ts` (`pnpm
test:memory`). Not verified live: the run also holds candidate questions
(years of experience related to the position, the AI-matching choice, the
basic job requirements) and was not retried.
