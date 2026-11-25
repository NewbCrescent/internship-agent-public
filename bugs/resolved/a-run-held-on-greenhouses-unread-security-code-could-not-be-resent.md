# A run held on Greenhouse's unread security code could not be resent

Found 2026-11-25 on the real workspace, after the fix above. The Artefact
run (Greenhouse, job <run id>, run <run id>) was held on the security code
Greenhouse emailed: `paused-needs-input`, the approval withdrawn, the
`site-security-code` safeguard its only open pause, its other pauses
answered, and one `verification-code` capture after the policy's approval.
Nothing was sent, but no path could resend it. `--reopen-unsubmitted`
accepted only a failed submit, a plain retry refused it because of the
answered pauses, and `approveRunSubmission` refuses any run with a
safeguard pause. The pause's own advice ("Retry it with pnpm pipeline:retry
--run <ref>") therefore failed too. The receipt gate could not be met
either: such a run has no possible-submission hold, so `pnpm mail:scan
--receipt` never checks it. Now `--reopen-unsubmitted` also reopens this
exact shape, but only on a pipeline-started run, on a job still applying,
with every other run cancelled. The shape: paused, the approval withdrawn,
the security-code safeguard its only open pause, no confirmation and no
trusted receipt, and every capture since the timeline's newest approval
event (`Submission approved…`) a `verification-code` capture, the newest on
a Greenhouse board. Greenhouse completes nothing until the code is entered,
so this shape is the proof and no receipt check is needed. The run is
cancelled, the job goes back to READY_FOR_REVIEW, and the next pass starts
a fresh automatic run; answered single-use pauses are not carried over. The
pause now names `pnpm pipeline:retry --run <ref> --reopen-unsubmitted
--reason "<why>"` (a non-Greenhouse code step keeps the plain retry).
Regressions: the security-code hold cases in
`testing-harness/agent/automatic-retry.integration.test.ts` (`pnpm
test:agent:retry`): the real auto-submit path reopened with no receipt
check and resubmitted; refused with another open pause, a CAPTCHA
safeguard instead, non-code or non-Greenhouse evidence, no evidence, a
capture before the approval event, a confirmed receipt, an approval not
withdrawn, and no approval on the timeline. Not changed: every other
refusal, and the receipt gate for failed submits.
