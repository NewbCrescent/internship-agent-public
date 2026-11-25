# Previous-employment questions naming the employer's group or using "did you work here" were not answered

Found 2026-11-25 on the real workspace. "Have you previously been employed
by any Micron company?" (micron.wd1, <run id>, a "Micron Technology"
posting), "Did you work here before?" (littelfuse.wd1, <run id>) and "Have
you ever been employed by Highmark Health, Allegheny Health Network, or …
affiliates…" (highmarkhealth.wd1, <run id>, an enGen posting) paused
unmapped, although the candidate's saved previous-employment answers
settle them. Cause: the mapper accepted a previous-employment question only
when it said "here" or "this company" or named the posting's company as
whole words, and its pattern had no "did you work" form; Micron's label
names only part of the posting's company and enGen's names its parent,
which runs the Workday site. The mapper now also reads "did you (ever)
work or intern", and on a Workday application the site's tenant spelled by
consecutive whole words (micron, highmarkhealth) names this employer; the
posting company's scope applies. A saved No never answers such a question
when it names a company the candidate has a saved Yes for: it asks the
candidate. Regressions: the previous-employment cases in
`testing-harness/agent/question-mapper.test.ts` (`pnpm test:agent`), the
saved-company cases in `testing-harness/agent/memory-service.integration.test.ts`
(`pnpm --filter @internship-agent/agent test:memory`) and the
`mentionsSiteTenant` cases in `testing-harness/domain/candidate-facts.test.ts`
(`pnpm test:domain`). Not changed: an answer typed for such a pause is
mapped without the site's tenant.
