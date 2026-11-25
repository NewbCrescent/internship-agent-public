# Workday's security check after Apply Manually was reported as a possibly closed posting

Found 2026-11-25 on the real workspace. Harbor <run id> (employer-a.wd115) is an
open posting; on 2026-11-25 a fresh disposable Chromium got Workday's
Cloudflare "Security Check" page (`cloudflare_error`, a Turnstile
"Verifying..." widget) after Apply Manually, and the old entry waited 20 s
and said "the posting may be closed". Cause: entry waited only for the
flow or the account form after Apply Manually. Entry now reads Workday's
`cloudflare_error` page (on the job page, also a visible challenge
`challenge.ts` recognizes) as a security check: the run stops as "needs
you" with that reason, and the check is never solved or bypassed; a
CAPTCHA on Workday's account form stays the account service's hold.
Regressions: the fixture's `security` and `security-page` modes
(`pnpm test:browser:fixture`) and the security-check case in
`run-lifecycle.integration.test.ts` (`pnpm test:browser-worker:local`).
Not verified live: an automatic run on Harbor after the change.
