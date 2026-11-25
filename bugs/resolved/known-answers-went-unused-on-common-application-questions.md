# Known answers went unused on common application questions

Recorded runs paused on questions the agent could already answer: "legally
eligible to work in the country you are applying for" was not read as work
authorization; Greenhouse's "How would you describe your gender identity /
racial/ethnic background? (mark all that apply)" lists were vetoed as open
prompts and the race list was not even marked sensitive; "Which college did
you attend?" and options carrying a US state code ("…(CA)") did not match the
profile school, and the "If you selected other, please specify" box after it
paused; "What degree level are you currently pursuing…" was not read as the
degree; a graduation year list was compared with the full graduation date;
"Please provide a link to your LinkedIn profile." did not match the LinkedIn
label; a required marketing Yes/No list paused although marketing is always
declined; "Are you a current college student majoring in computer science or
related field?" had no rule; and package answers were offered to choice
fields (a pause echoing the package text, or an optional choice paused instead
of skipped) and to background-check questions. Each now has a deterministic
rule (this also resolves the "Package answers fill select and radio fields"
entry below). Regressions:
`testing-harness/agent/question-mapper.test.ts` (`pnpm test:agent`),
`testing-harness/browser-worker/self-identification.test.ts`,
`ats-classification.test.ts`, and `recognition-planner.test.ts`
(`pnpm test:browser-worker:fast`), and
`self-identification.integration.test.ts` (`pnpm test:browser-worker:local`).
