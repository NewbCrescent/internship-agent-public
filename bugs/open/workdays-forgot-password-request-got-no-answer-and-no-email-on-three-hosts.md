# Workday's forgot-password request got no answer and no email on three hosts

Found 2026-11-27 on the real workspace (blocker "the agent asked Workday for a password-reset email, and none arrived within N minutes").
Three automatic runs (jobs <run id>, <run id>, <run id>; 05:08Z, 05:11Z and 10:35Z) used Track 65's forgot-password flow and held 3 minutes later.
Evidence: no Workday, password or reset mail arrived after any of the three clicks in INBOX, All Mail, Spam or Trash through 12:36Z (read-only header listing, Track 75 triage).
The workday-account evidence saved at each hold (3 minutes after the click) shows Workday's Forgot Password form still on screen with the account email typed, no message and no error.
So Workday never answered the submit; the reset email was never sent.

Likely cause, not verified: `requestWorkdayPasswordReset` clicks the reset submit right after typing the email, while Workday's sign-in widget silently drops an account submit made under 500 ms after its button mounts (see workday-ignored-an-account-submit-made-within-500-ms-of-the-form-appearing.md).
Sign-in and create wait one second since 2026-11-24, but AGENTS.md allows that wait only for sign-in and create-account submits.
No DOM or network of the forgot form was captured (the reset step is kept out of run traces).
Not ruled out either: the account email at these sites may differ from the mailbox address.

Fix so far (Track 75): the outcome is now reported truthfully.
`requestWorkdayPasswordReset` returns `no-answer` when the form is still on screen as submitted after its 20-second answer wait, and `resetFlow` (packages/agent/src/workday-account-service.ts) still reads the mailbox and holds as `interrupted` with "…but Workday showed no answer: its Forgot your password? form stayed on screen with no message, and no email arrived within 3 minutes…".
Regression: the `reset-silent` scenario in testing-harness/browser/workday-account-run.ts (`pnpm test:browser:workday-account`), against the fixture's `&reset=silent` mode.

fixture: modelled (the end state, the form left as submitted with no message and no email, is captured from three real hosts' evidence, 2026-11-27; the silent drop itself is modelled)

Open: waiting on the candidate's decision whether the one-second wait may also cover the forgot-password (and resend) submits (an AGENTS.md site-safeguard change); until then these hosts stay held.
Move to bugs/resolved/ once a real pass gets Workday's answer (an email or a message) to a reset request.

## Refuted causes

- The reset email arrived but the reader missed it (sender, subject wording, folder, the newest-N header cut, or the time window). Evidence: read-only header listing of INBOX, All Mail, Spam and Trash, 2026-11-27 00:00Z to 12:36Z (Track 75 triage): no Workday, password or reset mail after any of the three clicks; INBOX held 46 messages since 2026-11-26, under the reader's 500-header cut.
- Workday sends reset emails late. Evidence: the same listing, 2 to 7 hours after the clicks.
- Workday answered with a message the agent did not read. Evidence: the workday-account evidence 3 minutes after each click (2026-11-27T05-11-01, 05-14-34, 10-38-10) shows the unchanged Forgot Password form, no message and no error.
