# Workday's verification link shown only as text was never found

Found 2026-11-26 on the real workspace: blocker b5c84b208ff held 12 jobs as
"verification email not found within 3 minutes".
Across 32 agent-created Workday accounts, no "verification email found and
opened" event had ever been logged.
Nine real tenants' "Verify your candidate account" emails, from
`otp.workday.com`, were in the mailbox, each received 0–5 minutes after that
host's create.
All nine are HTML-only (no plain-text part) and show the activation link only
as text in the HTML body: no `href` holds it and no anchor wraps it; the link
is on the tenant's own host.
`linksIn` in `packages/agent/src/workday-verification-mail.ts` read links
only from `href` attributes and the plain-text part, so it returned "none"
for every one of them.

Fix: `findWorkdayVerificationLink` now reads, for a message whose hrefs and
plain-text part give no accepted link, the URLs shown as text in its HTML
body (script and style dropped, tags as spaces, entities decoded); every
other check (tenant host or Workday domain, activation path, relevance,
clock skew, ambiguity across messages) is unchanged.
Regressions: the HTML-text tests in "Workday verification links" in
`testing-harness/agent/workday-account.test.ts`
(`pnpm test:agent:workday-account`) and the `html-text-link` scenario in
`testing-harness/browser/workday-account-run.ts`
(`pnpm test:browser:workday-account`).

fixture: captured 2026-11-26 (message structure read from the real mailbox, read-only and in memory; the fixture text and hosts are synthetic)

Verified live (2026-11-26, read-only): the fixed reader against the real
mailbox returns "found" for the 9 tenants whose email arrived and "none" for
the 3 whose email never arrived; nothing was opened, written or marked read.
Not verified live: opening a real tenant's link and signing in; the next due
pass of each held host proves it.

## Refuted causes

- Later passes never re-check the mailbox. Evidence: timeline re-check events ("the agent looks for the verification email") 4–5 times on 3 hosts, and session details rewritten on later passes for the others, real database read-only, 2026-11-26.
- The verification emails never arrived. Evidence: one "Verify your candidate account" email per tenant in the mailbox for 9 of the 12 hosts, read-only read 2026-11-26.
- The From/Subject relevance filter missed them. Evidence: the production reader returned 2–8 Workday messages per host, read-only read 2026-11-26.
- The link is on a host other than the tenant's. Evidence: the masked link shapes are all on the tenant's own `*.myworkdayjobs.com` host, read-only read 2026-11-26.
- The mailbox is not the account's address. Evidence: the Gmail address and `INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL` are the same address, compared without printing, 2026-11-26.
- The 3-minute polling window was too short. Evidence: each email arrived 0–5 minutes after its create, and later passes read the mailbox again without finding a link.
