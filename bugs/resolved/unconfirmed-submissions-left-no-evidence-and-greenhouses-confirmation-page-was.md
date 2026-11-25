# Unconfirmed submissions left no evidence and Greenhouse's confirmation page was not read

Two automatic submissions on 2026-11-20 ended failed with "The submit button
was clicked and the application dialog closed, but no confirmation text was
recognized": Lumora (Ashby, run <run id>, about 05:30Z, before run N added
Ashby's success container) and Tidewave (Greenhouse new board, job <run id>,
about 10:15Z on <run id>). No confirmation email arrived from either company
(the manager checked the candidate's Gmail), so most likely neither went
through, but that is unknown: the app kept nothing of what the page showed.
The confirmation reader also never read Greenhouse's `/confirmation` or
Lever's `/thanks` address, and a job description's "Thank you for your
interest" hid a later "Thank you for applying" (both tallied as "thank you").
Now a new Greenhouse `/confirmation` or `?confirmation` URL or Lever `/thanks`
URL confirms, the longer phrases ("Thank you for applying", "We've received
your application") are counted on their own, fields the site marks invalid
after the click pause the run with the site's error text and the approval
withdrawn (retryable with `pnpm pipeline:retry`, since nothing was sent),
and refused, challenged, and unknown outcomes fail closed with local
evidence (a full-page screenshot and redacted text, mode 600, never sent to
Discord or a model) that `pnpm run:evidence --run <ref>` prints. Both runs
stay failed and are never retried automatically; the candidate checks those
applications on the sites. Regressions: the "post-submit outcomes" tests in
`recognition-planner.test.ts` and `run-lifecycle.integration.test.ts`, the
field-error and unconfirmed retry cases in
`automatic-retry.integration.test.ts`, `submit-evidence.integration.test.ts`,
and the post-submit scenarios of `pnpm test:browser:greenhouse` (the
confirmation redirect, the inline thanks under a description that already
says thank you, Lever's /thanks, field errors, a banner, a challenge, and a
silent click).
