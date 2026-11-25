# Package answers filled questions they do not answer

Track 10's review of the two SemiAnalysis Dover runs (job <run id>, "Summer
Intern - AI Tokenomics", and job <run id>, "Semiconductor & AI Research
Intern") found required free-text questions filled with the package's generic
"Why are you interested in this role?" answer ("I am applying for the <title>
role at <company>. …"), one of them a technical question about CPX vs NVL72
prefill. Cause: `matchPackageAnswer` in
`packages/browser/src/autofill-planner.ts` matched on single word stems (why,
interest, motivat, company; experience, background, relevant, project,
qualification; authoriz, sponsor, start, availab, eligible, work in), so any
text question containing one of them received a canned answer. Fixed
2026-11-24: a package answer fills a text box only when the whole label
(without its required marker, "(optional)", a trailing length hint, and end
punctuation) is one of a fixed set of phrasings of the same question (why are
you interested in this role or company, describe your relevant experience, a
work-authorization or availability summary); a technical "why" question,
"Which company…", "Describe a project where…", "How many years of
experience…", "Explain why…", and every other label follow the usual rules
(question memory, a voice draft, an optional skip, or a pause). The package
contents are unchanged. Regressions: "gives a package answer only to a question
that asks the same thing" in
`testing-harness/browser-worker/recognition-planner.test.ts`
(`pnpm test:browser-worker:fast`). Runs already saved with such fills are not
changed.
