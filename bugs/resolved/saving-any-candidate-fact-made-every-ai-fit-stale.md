# Saving any candidate fact made every AI fit stale

Found 2026-11-25 on the real workspace. Loading facts with `pnpm
profile:facts --set-file` and saving one answer with `pnpm run:answer`
raised the AI-fit context version from 57 to 64, so all 228 cached fits went
stale and the next pass held every posting with "Fit: no current AI
judgment." until it was re-scored, at most 25 per pass. Cause: the
`candidate_facts` triggers (migration 0024, rebuilt by 0030) bumped the
context version on every fact write, but the fit prompt reads only one
fact, `graduation_date` (the expected graduation in its level context);
legal, sensitive, and application-only answers never reach it. Migration
0034 recreates the three triggers so they fire only for the keys in
`FIT_CONTEXT_FACT_KEYS` (packages/domain `matching.ts`), which the fit
builder's key type is limited to; it does not bump the version itself, so
fits scored before it stay current. Regressions:
`testing-harness/db/fit-context-facts.test.ts` (`pnpm test:db`) and the
fact-key and fact-staleness tests in
`testing-harness/matching/semantic-fit.integration.test.ts` (`pnpm
test:matching:local`).
