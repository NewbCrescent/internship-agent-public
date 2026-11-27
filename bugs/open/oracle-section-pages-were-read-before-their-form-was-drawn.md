# Oracle section pages were read before their form was drawn

Two runs on 2026-11-27 (pass 28) stopped with "No application form was found
at …/job/<id>. It may sit behind an Apply button": Stantec (…/sites/CX_1/job/1009005)
and Corvane's AI Building Intern (…/sites/CX_1001/job/11324). Both stop
captures are already past the Apply button, at `/apply/section/1`:
Stantec's 1.7 s after the email step's consent event, with the
`apply-flow-page--one-page` region showing the "Import your profile" block
drawn and the "Contact Information" block's `apply-flow-block__form-list`
still empty (the page text lists every section heading down to SUBMIT);
Corvane's with an empty `<div class="apply-flow-page"></div>` (no email
step: the agent's browser profile already had an Oracle session there) and a
hidden "You're all set!" checklist dialog. `recognizeCurrentForm` waits only
until any control count is steady for 1 s, which the early import box (or
the chatbot's box) satisfies, so the form was read empty.

Fix (Track 63): `oracle.formReady` (`packages/browser/src/ats/oracle-apply.ts`)
waits, up to 30 s, until the section shows visible form controls outside
the import box and the chatbot, the same count three reads in a row, and
`passOracleEmailStep` (`packages/agent/src/oracle-email-step.ts`) calls it
after the email or code step leads to the form and when a run opens at a
section page directly, before the form is recognized. A form that never
draws still meets the existing no-form stop, now after waiting.

Regressions: `pnpm test:browser:oracle-apply` scenarios (13) and (14) (a
section drawn 2.5 s late after the email step, and opened directly) and
`pnpm test:browser-worker:oracle` (a run opened at a section whose controls
show only after formReady); each fails on the old code.

fixture: modelled (markup from the 2026-11-27 stop captures; the draw delay is modelled)

Open until a live run confirms both postings reach their forms.

## Refuted causes

- A closed posting. Evidence: both captures are at /apply/section/1 under the "Job application form" heading; Stantec's lists the application's sections down to SUBMIT.
- An Apply button that was not followed. Evidence: both captures are already past it at /apply/section/1.
