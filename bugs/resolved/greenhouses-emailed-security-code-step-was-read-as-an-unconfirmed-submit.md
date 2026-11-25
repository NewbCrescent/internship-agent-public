# Greenhouse's emailed security-code step was read as an unconfirmed submit

Tidewave (Greenhouse new board, job <run id>, 2026-11-20 10:08Z) failed as
unconfirmed ("no confirmation text was recognized") after its automatic
submit click. At 10:09:26Z the Gmail watcher logged "Security code for your
application to Tidewave" from us.greenhouse-mail.io, so the site had asked
for an emailed security code after the click and the application was not
completed. The app had no outcome for that step, and `pnpm pipeline:retry`
refused the failed run because its submit was approved. Now the step (new
security-code inputs plus text about a code sent by email) is the
`verification-code` outcome: on a Greenhouse board the code is read from the
candidate's mailbox (read only, every 10 s for up to 3 minutes; a Greenhouse
sender, a subject naming the security code and the company, exactly one
distinct code), typed in, and the step's own submit clicked before the
confirmation wait restarts; otherwise the run is held `paused-needs-input`
with the approval withdrawn ("Greenhouse emailed a security code; it was not
found …"), and a step still shown after entry fails closed. The code is never
logged, stored, or put in an event, notice, error, or evidence (texts are
scrubbed, no screenshot after it was typed).
`pnpm pipeline:retry --run <ref> --reopen-unsubmitted --reason "<text>"`
reopens a failed submit only with evidence the site did not complete it (the
security-code email event after the approval, or verification-code evidence)
and never one with a confirmation. The step's markup and the email's wording
come from third-party descriptions, not a capture. Lumora (Ashby, run
<run id>) is left as is: no public markup knowledge of an Ashby email-code
step was found, and no email arrived. Regressions: the "Greenhouse's emailed
security code" tests in `recognition-planner.test.ts` and
`run-lifecycle.integration.test.ts`, the `--reopen-unsubmitted` cases in
`automatic-retry.integration.test.ts`, the verification-code cases in
`submit-evidence.integration.test.ts`, `greenhouse-security-code.test.ts`
(`pnpm test:agent:security-code`), and the `?code=1` scenarios of
`pnpm test:browser:greenhouse`.
