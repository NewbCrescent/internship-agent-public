# Failed submits the site never took could not be reopened, closed, or corrected

`pnpm pipeline:retry --reopen-unsubmitted` accepted only Greenhouse's
security-code evidence (the email after the click, or a verification-code
capture), so failed submits whose saved evidence shows the site never took
the click stayed held as possible submissions with no way out: the Ashby
refusals while Ashby was still saving (Contoro <run id>, First Resonance
<run id> and <run id>: the intact filled form, an enabled Submit
Application button, no success, failure, or CAPTCHA container, receipt
checks absent), the Dover runs left at an unchecked Turnstile (<run id>,
SemiAnalysis <run id> and <run id>), and the Greenhouse auto-submits that
found no submit control because the posting had closed (<run id>,
<run id>). Two Ashby runs (Brightlane <run id>, Lumora <run id>) were
recorded as SUBMITTED on 2026-11-21 only through a "Modal dialog closed
after submit without errors" relabel, and nothing could correct that.
Now `--reopen-unsubmitted` also accepts, deterministically, a capture with
Ashby's busy detail, a Dover capture with the Turnstile challenge, and an
older capture judged only from its evidence.json (same application page, no
confirmation, failure, error, or invalid field, the submit control and the
uploaded resume still shown, and on Dover a Turnstile marker); every
capture after the approval must pass, the refusal names the missing
signal, and the fresh absent receipt check still applies.
`--close-unsubmitted --reason` cancels a never-clicked failed submit ("No
submit control was found" after the approval) whose capture shows the
posting closed, and skips the job as "Posting closed"; it never retries.
`--correct-submitted --reason` (writes only with `--confirm`) corrects a
SUBMITTED record that rests only on the closed-dialog relabel when the
evidence shows the site never took it: the run becomes failed and held as
a possible submission, the job is APPLYING again, the old confirmation is
quoted in a new event, and no history is deleted. Boundary: the three
older Dover captures carry no Turnstile marker in their saved text (the
widget draws inside a frame the capture cannot read), so they stay
refused; <run id> has no saved evidence, so it stays SUBMITTED; this
change applies nothing to the real records (the manager runs the
commands). Regressions: the never-taken, `--close-unsubmitted`, and
`--correct-submitted` cases in
`testing-harness/agent/automatic-retry.integration.test.ts`
(`pnpm test:agent:retry`).
