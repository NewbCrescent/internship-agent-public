# Oracle Candidate Experience runs stopped at the email step

Nine Oracle Cloud HCM runs on 2026-11-24 (INL, Corvane, Vertiv, Stantec,
Worthington) stopped with "Oracle Cloud HCM asks for your email at <host>,
then emails you a one-time code, before its application form; the agent does
not take that step yet.": no adapter took `/apply/email`. Now
`packages/browser/src/ats/oracle-apply.ts` reads and drives the email, terms,
and PIN screens (derived from Oracle's public Candidate Experience bundle and
a read-only capture of two tenants' email steps), and
`packages/agent/src/oracle-email-step.ts` takes the step in start, continue,
and submit: the saved email is typed only when it is the mailbox the agent
reads, the terms box is ticked only under the standing data-consent setting
and logged with its exact text, and an emailed six-digit code is read from
the candidate's own mailbox (`oracle-verification-mail.ts`, never logged or
stored) and typed once, never resent. No code, several codes, a refused
code, a CAPTCHA, an identity check, an already-applied screen, or an
unrecognized step stops the run with a fixed reason. Oracle's default label
"I agree with the terms and conditions" is accepted under the standing
data-consent setting through the terms-of-use group (Track 8) and logged;
without the setting the run stops at the terms step with nothing typed.
Regressions: `pnpm test:browser:oracle-apply`,
`pnpm test:browser-worker:oracle`, `pnpm test:agent:oracle-code`. Boundary:
the PIN and section fixtures are derived, and the step was never run against
a live code.
