# A Workday account that already existed with another password was never recovered

Found 2026-11-26 on the real workspace.
On two hosts the candidate had used with the same address before (2025 and
October 2026 application mail, read-only scouts), the create was read as
created, no verification email came, and the agent's new password was
refused on every pass; one more host never sent an email at all, and two
other hosts have held refused saved passwords since 2026-11-25.
The agent never reset a password, so each such host stayed held for the
candidate.
The candidate allowed the agent to use Workday's "forgot password" email flow
on these accounts on 2026-11-27 ("3 yes you can do the forgot password").

Fix (Track 65): `packages/browser/src/ats/workday-account.ts`
(`requestWorkdayPasswordReset` and `completeWorkdayPasswordReset`, wired as
`WorkdayPage.requestPasswordReset` and `completePasswordReset` in
`packages/browser/src/ats/workday.ts` and kept out of run traces in
`packages/browser/src/run-trace.ts`) clicks "Forgot your password?" once,
submits the account email, and on the emailed reset page types a new
password only once its two password fields show;
`packages/agent/src/workday-account-service.ts` (`resetFlow`) runs it on
automatic runs with a mailbox after the third empty verification read, an
"already exists" create whose one sign-in is refused, a refused sign-in of an
account saved as created, and an account saved as refused whose hold was
cleared; `packages/agent/src/workday-verification-mail.ts`
(`findWorkdayPasswordResetLink`, `pollPasswordResetLink`) accepts one reset
link on the tenant's own https origin from mail that arrived after the click.
The new password is generated like the create step's and saved to the
accounts file (0600) right before it is typed, and the agent signs in with
it; at most one reset request per host per 24 hours (`resetAt`); CAPTCHAs and
text-message, phone, or security-question steps hold; the password, link, and
token are never logged.
Regressions: the `reset`, `no-email-reset`, `reset-no-email` (and its later
pass) and `reset-captcha` scenarios in
`testing-harness/browser/workday-account-run.ts`
(`pnpm test:browser:workday-account`), the "Workday password-reset links"
cases in `testing-harness/agent/workday-account.test.ts`, and the reset-time
and reset-polling cases in
`testing-harness/agent/workday-account-store.integration.test.ts`.

fixture: modelled (the "Forgot your password?" control id is captured, 2026-11-19; the forgot form, the reset email (sender, subject, and two-hour expiry from public sources, 2025-11-06), the reset link's path and the reset page are modelled)

Move to bugs/resolved/ once a real pass resets the password on one of these hosts and signs in.

## Refuted causes

- The verification email was missed. Evidence: no Workday mail for these two hosts in INBOX, Spam, All Mail or Trash since 2026-11-17 (read-only scout, 2026-11-26).
- Workday needed more time to send it. Evidence: the nine real verification emails arrived 3–22 seconds after their creates.
