# Ashby application sites were not recognized

Runs <run id> (Brightlane) and <run id> (Lumora) on jobs.ashbyhq.com were
"unknown" and held on "Unlabeled input control 1" (Ashby's "Autofill from
resume" parser box), "Name", "LinkedIn", and an optional "Cover Letter". Now
jobs.ashbyhq.com (and `ashby_jid=` pages) is kind `ashby`, proceeding like
Greenhouse; the parser box is not a question; "Name" fills the profile name,
"LinkedIn" the profile URL, the resume field the uploaded resume, and an
optional cover letter (or other non-resume upload, on any site) stays empty.
Regressions: `ats-classification.test.ts`, `recognition-planner.test.ts`, and
the Ashby scenario of `pnpm test:browser:greenhouse`
(`fixtures/ashby-application.html`, reduced from a read-only capture).
