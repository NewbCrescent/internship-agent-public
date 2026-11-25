# Greenhouse's security code was not found when its email named another organization

Found 2026-11-25 on the real workspace. Artefact (Greenhouse, job <run id>,
run <run id>) was approved by the auto-submit policy at 02:58:37Z, Greenhouse
showed its emailed security-code step, and at 03:02:24Z the run was held with
"Greenhouse emailed a security code; it was not found in your mailbox in time,
so nothing was sent." A read-only IMAP check (headers and structure only)
showed the email had reached the INBOX at 02:59:22Z, well inside the wait,
from no-reply@us.greenhouse-mail.io, HTML only, with an 8-character code after
the "…on your application:" anchor the lookup reads. Cause: the subject named
the board's Greenhouse organization, a job-wrapping service ("Security code
for your application to LinkedIn Job Wrapping"; the board is
`artefactlinkedin`), not the posting's company, and the lookup accepted only
subjects naming the posting's company, so the mailbox never read the message.
The poll window, time zone, folder, and code layout were not the cause. Now
mail naming the posting's company still decides first; after 60 s of polling
without it, Greenhouse security-code mail naming any organization counts, with
the same sender, 30-second window, and exactly-one-code rules (two codes hold
the run as ambiguous). Not changed: the `--reopen-unsubmitted` security-code
email check (`unsubmittedEvidence`) and the Gmail watcher's application
matching still need the posting's company in the subject. Regression: the
job-wrapping cases in `testing-harness/agent/greenhouse-security-code.test.ts`
(`pnpm test:agent:security-code`).
