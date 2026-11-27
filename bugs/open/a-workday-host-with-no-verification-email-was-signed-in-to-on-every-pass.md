# A Workday host with no verification email was signed in to on every pass

Found 2026-11-26 on the real workspace, as part of blocker b5c84b208ff.
Three hosts (job <run id>; job <run id>; job <run id> with jobs <run id> and
<run id>) had their create read as created, never received a verification
email, and were signed in to and refused 4–5 times each on the
`verify-email` backoff (1 hour, doubling to 24 hours), which never ends.
Each pass logged "Workday refused the sign-in while the account waits for
email verification; the agent looks for the verification email." and then
found an empty mailbox.
The manager's read-only scouts found that the candidate had used two of those
sites with the same address before, so the agent's new password could not
work there.
After a verification link was opened, a sign-in that still asked to verify
also held as `verify-email`, so a link that no longer verifies would be
reopened, and the password typed, on every due pass.

Fix (`packages/agent/src/workday-account-service.ts`): the third mailbox read
in a row that finds no verification email holds the host as `interrupted`
("…the account may already exist with another password, or was never
created. The agent stops trying and never resets passwords."), so no later
pass types the password again; after the agent opened the link, a sign-in
that still asks to verify holds as `interrupted` ("…so the link may have
expired; the agent does not open it again."), and a refused sign-in holds as
`wrong-password` with a reason that names the opened link.
No resend or forgot-password control is clicked.
Regressions: the `no-email-waits`, `no-email-stops`, `link-unverified` and
`link-refused` scenarios in `testing-harness/browser/workday-account-run.ts`
(`pnpm test:browser:workday-account`).

fixture: modelled (synthetic fixture modes; the loop itself is on the real timelines, 2026-11-26)

Track 65: the third empty read now first asks Workday for a password-reset email with its own Forgot your password? control (at most once per host per day) and holds as interrupted only when that cannot run or finds no email; see a-workday-account-that-already-existed-with-another-password-was-never-recovered.md.

Move to bugs/resolved/ once a real pass resets the password on, or holds as interrupted, these three hosts.

## Refuted causes

- The verification email arrived but was missed, as on the nine other hosts. Evidence: the fixed reader found none for these three hosts (read-only real-mailbox read, Track 60 round 1), and the manager's scouts found none in INBOX, Spam, All Mail or Trash.
- Workday needed more time to send it. Evidence: the nine real verification emails arrived 3–22 seconds after their creates.
