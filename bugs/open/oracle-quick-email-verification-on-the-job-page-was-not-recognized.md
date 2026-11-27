# Oracle quick email verification on the job page was not recognized

Worthington Enterprises' AI Intern run on 2026-11-27 (pass 28) stopped with "its email step did not show the
expected email box and Next button, so nothing was typed." Its run trace
(trace-job-2026-11-27T01-26-48-590Z, screencast and action log, no DOM
snapshots) shows that after the Apply click the tenant asks for the email on
the job page itself: the body carries
`data-route="job-details.quick-email-verification"` and reads
"Authentication screen. Let's get started / What's your email? / … / I agree
with the terms and conditions", with a round icon-only ">" Next button and a
cookie notice (ACCEPT only) partly over it. No URL change was recorded.
`oracleApplyScreenOf` read the email screen only at `/apply/email`, so the
page was "other" and `submitEmail` returned "unexpected" before typing.

Fix (Track 63, `packages/browser/src/ats/oracle-apply.ts`): a body route
ending `email-verification` (or `quick-email-verification`) with one email
box is the email step; when the box's form has no visible submit button,
the one visible Next or Continue button (aria-label, title, or text) of the
page's main region outside a cookie notice is its Next; a Next that is
disabled until the email and terms are given is accepted, and after typing
and the terms decision the step waits up to 3 s for it to become clickable
("the email step's Next button did not become clickable" otherwise). Nothing
is typed before the terms decision, Next is clicked once, Resend never. An
email-step stop before any code now saves a `step-transition` capture, so a
next miss shows the markup.

Regressions: `pnpm test:browser:oracle-apply` scenarios (10)–(12) (the
route, a Next in the form, a disabled round Next outside it, declined terms,
and a start run from the quick job page); each fails on the old code.

fixture: modelled (the route name and page text captured from run trace 2026-11-27T01-26-48; the URL, the Next markup and its enabled state were not)

Open until a live run passes it. The cookie notice offers only ACCEPT, which
the agent never clicks; if it covers the Next button, the run still stops.

## Refuted causes

- A CAPTCHA on the email step. Evidence: the trace's findVisibleChallengeIn result was null.
- The terms box was declined. Evidence: the stop text is submitEmail's "unexpected" result, returned before the terms are read.
