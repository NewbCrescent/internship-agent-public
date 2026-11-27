# An expired Workday verification link was never replaced with a new one

Found 2026-11-26 on the real workspace.
Nine hosts got Workday's "Verify your candidate account" email from
`otp.workday.com` seconds after their creates (2026-11-25 and 2026-11-26).
Before Track 60 the agent never read those links; by the time Track 60 could
read them, the emails were one to two days old, and Workday's emailed
candidate links are one-time links that expire after about two hours (reset
links, per an employer's recruiting team on a public forum, 2025-11-06; no
lifetime was found for verification links).
Workday's sign-in page for an unverified account shows "Verify your account
before you sign in or request a verification email." and a "Resend Account
Verification" control (read-only workday-account evidence text, 2026-11-25
and 2026-11-26), but the agent had no way to use it, so after an opened link
that no longer verified it could only hold the host for the candidate.
The candidate allowed the agent to click Workday's resend control on
2026-11-27 ("2 yes").

Fix (Track 65): `packages/browser/src/ats/workday-account.ts`
(`resendWorkdayVerification`, wired as `WorkdayPage.resendVerification` in
`packages/browser/src/ats/workday.ts` and kept out of run traces in
`packages/browser/src/run-trace.ts`) clicks the sign-in page's own resend
control once, found by its label, and never touches the password;
`packages/agent/src/workday-account-service.ts` (`resendFlow`) uses it on
automatic runs with a mailbox when the sign-in after an opened link still asks
to verify or is refused, and before opening a found link from an account
created or last resent two hours or more before, then reads the mailbox for a
link that arrived after the click and is not one it already had
(`findWorkdayVerificationLink`'s `exclude`, in
`packages/agent/src/workday-verification-mail.ts`), opens it, and signs in.
It resends at most once per host per 24 hours (`resentAt` in the accounts
file, `packages/agent/src/workday-account-store.ts`) and logs "resent the
verification email at Workday's request."; without the control the earlier
holds are unchanged.
Regressions: the `resend`, `resend-old`, `resend-again` and
`link-unverified` (no control: nothing clicked, the earlier hold kept)
scenarios in `testing-harness/browser/workday-account-run.ts`
(`pnpm test:browser:workday-account`), and the `exclude` case in
`testing-harness/agent/workday-account.test.ts`.

fixture: modelled (the control's label and the alert text are captured from workday-account evidence text, 2026-11-25 and 2026-11-26; the control's markup, its effect, and the confirmation are modelled; no DOM was captured)

Move to bugs/resolved/ once a real pass signs in to one of these hosts after a resend.

## Refuted causes

- The verification emails never arrived. Evidence: read-only header listing (Track 60 scout, 2026-11-26) found otp.workday.com "Verify your candidate account" mail 11–12 s after the creates.
- The reader still misses the link. Evidence: Track 60's html-text-link regression and its read-only real-mailbox read found exactly one tenant-origin link per host.
