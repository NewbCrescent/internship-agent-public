# Previous-employment questions naming the employer by its first word were not answered

Found 2026-11-25 on the real workspace, in pass 13. Example Brands'
"Have you worked for Constellation before?" (examplebrands.wd5, run <run id>)
paused unmapped although the candidate's saved previous-employment answer
covers it. Cause: the mapper took a question as this employer's only when it
said "here" or "this company", named the posting's whole company name
(`mentionsCompany`), or spelled the Workday tenant; "Constellation" is
neither the whole name nor the tenant (examplebrands). Fix: `mentionsCompanyLead`
(`packages/domain/src/company-name.ts`) also counts the first word or words
(never all) of the normalized company name, capitalized, as whole words
right after "for", "at", "by", "with", "within" or "of" (optionally "the"),
and never followed by another capitalized word ("Constellation Energy" is
another company); the first word needs at least 4 letters and a one-word
name never matches here. The mapper's previous-employment rule uses it
(`packages/agent/src/question-mapper.ts`); the scope stays the posting's
company and a saved No still never answers a question that also names a
company with a saved Yes. National Interstate's "Have you worked at American
Financial Group, Great American Insurance Group, or any of its subsidiaries
before?" (employer-f.wd1, run <run id>) deliberately stays with the candidate: it
names a family of companies, not the posting's company, and no saved answer
covers every company in it. Regression: the `mentionsCompanyLead` cases in
`testing-harness/domain/candidate-facts.test.ts` (`pnpm test:domain`), the
leading-word and family-of-companies cases in
`testing-harness/agent/question-mapper.test.ts` (`pnpm test:agent`), and the
saved-No and saved-Yes-company cases in
`testing-harness/agent/memory-service.integration.test.ts` (`pnpm
test:memory`). Not verified live: the run was not retried in this change.
