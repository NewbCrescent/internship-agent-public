# Greenhouse's security-code email was DMed as a recruiter reply

The Gmail watcher read "Security code for your application to Tidewave" from
us.greenhouse-mail.io (2026-11-20) as a "Recruiter reply": it DMed the
candidate and logged "Email received: Recruiter reply …", which the daily
digest would count as a company reply. Security and verification code emails
are machinery. `mail-outcomes.ts` now files a subject naming a security
code, verification code, one-time code, or "Verify your account" (and a
would-be recruiter reply whose body names such a code) as the `verification`
category: never DMed (`scanUids`, `formatMailNotice`), never counted by the
digest (nor the older "Recruiter reply" note with such a subject), and still
noted as `Email received: Verification code from <domain>: "<subject>"` with
code-like subject tokens replaced by "[code]". The `--reopen-unsubmitted`
evidence check reads the label-agnostic note, so the Tidewave note stored
under the old label still counts. Regressions: `mail-outcomes.test.ts`,
`mail-watch.integration.test.ts`, `daily-digest.integration.test.ts`, and
the security-code note cases in `automatic-retry.integration.test.ts`.
