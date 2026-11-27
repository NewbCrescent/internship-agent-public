# The Gmail reader dropped a verification email once 50 newer messages arrived

`messagesSince` in `packages/agent/src/gmail-mailbox.ts` searched the INBOX
from the day before the anchor time and kept only the newest 50 UIDs before
filtering by date and relevance.
On the real workspace (2026-11-26) one held Workday host's verification
email, received 2026-11-24, had fallen out of the newest 50 of its
88-message window, so later passes could never find it (job <run id>).

Fix: the reader (`imapVerificationMailbox`) reads the headers of at most the
500 newest messages in the window and the bodies of at most the 20 newest
relevant ones received since the anchor (two minutes of clock skew); the
INBOX is still locked read-only (EXAMINE).
Regression: "Gmail verification reader" in
`testing-harness/agent/workday-account.test.ts`
(`pnpm test:agent:workday-account`), over a fake IMAP client.

fixture: modelled (synthetic message counts over a fake IMAP client; the cut itself was observed on the real mailbox, read-only, 2026-11-26)

Confirmed live (2026-11-26, read-only): the fixed reader against the real
mailbox returns the held host's verification email and "found" for job
<run id>; nothing was opened, written or marked read.

## Refuted causes

- The search's date window excluded the email. Evidence: the email is inside the (anchor − 1 day) window; it was dropped by the newest-50 cut, 88 messages in the window, real mailbox read-only, 2026-11-26.
