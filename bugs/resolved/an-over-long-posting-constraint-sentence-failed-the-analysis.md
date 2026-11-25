# An over-long posting constraint sentence failed the analysis

The retry pass of 2026-11-20 logged "Analysis failed for a6fc73c0-…" (and
b66d8785-…, six in all) with a `too_big` error at
`constraints.authorization.raw`, maximum 600. It was not a model string: the
deterministic extractor (`extractAuthorization` in
`packages/jobs/src/deterministic-extractor.ts`) keeps the whole "sentence"
around "authorized to work", and a sentence with no period or newline can be
longer than the schema's 600 characters; the write path stored it without
validation, so every read of the posting failed. Now a stated constraint
longer than 600 characters keeps a window of at most 600 around its keyword
(the decision still reads the whole sentence, so no eligibility reading
changes), and rows stored before that are clipped on read
(`clipStatedText` in `packages/domain/src/job-posting.ts`, used by
`getJobPosting`). Model-output schemas are unchanged. Regressions: the
over-long sentence case in `testing-harness/jobs/normalization-contracts.test.ts`
and the stored over-long row in
`testing-harness/matching/match-persistence.integration.test.ts` (`pnpm
test:matching:local`).
