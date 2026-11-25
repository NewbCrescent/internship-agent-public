# Workday entry stops left no evidence

Found 2026-11-25 on the real workspace. The eight stops of 2026-11-21
08:24 UTC (PTC, National Interstate, Jabil, Example Nonprofit,
Example Brands, NVIDIA, KLA, Granite Dynamics) came about 18 s apart
(the 15 s Apply wait expiring) and saved nothing; on 2026-11-25 all eight
postings were open and the unchanged entry reached Workday's Create
Account/Sign In step in a fresh profile within about 6 s, so their
2026-11-21 cause cannot be determined. Cause: only account-step and
step-error stops saved Workday evidence. Every entry stop (a closed
posting, a security check, or neither) now saves `workday-entry` evidence
(screenshot, redacted text, URL, the agent's detail), and the message no
longer claims the posting may be closed ("No Workday application opened at
<url>: Workday showed neither the application nor its closed-posting
page."). Regressions: the workday-entry case in
`testing-harness/agent/submit-evidence.integration.test.ts`
(`pnpm test:agent:evidence`) and the entry cases in
`run-lifecycle.integration.test.ts` (`pnpm test:browser-worker:local`).
Not verified: the 2026-11-21 cause.
