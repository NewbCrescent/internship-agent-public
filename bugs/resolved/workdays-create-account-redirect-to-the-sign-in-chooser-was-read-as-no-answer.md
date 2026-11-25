# Workday's create-account redirect to the sign-in chooser was read as no answer

Found 2026-11-25 on the real workspace, in passes 13 and 14. NVIDIA
(nvidia.wd5) held Finance AI Engineering Intern (<run id>) with "Workday did
not answer the create-account submit within 60 seconds; same-host response
status: 200, 303; page transition observed, and signing in once with the
saved password did not work, so the account was probably not created"; the
two NVIDIA jobs reached from jobs.nvidia.com (<run id>, <run id>) then
carried the same host hold without a second create. The evidence page was
the career site's `/login` with Workday's generic sign-in failure. Cause:
Workday's create handler (candidate-experience-apply-flow 2026.47.19, public
bundle read 2026-11-25) answers a successful create on a tenant that
verifies emails by sending the page to `<site>/login`, and a read-only
capture of nvidia.wd5's `/login` the same day shows only "Sign in with
Google", "Sign in with LinkedIn" and "Sign in with email". The agent counted
only the sign-in form as a created account, so it waited out the 60 seconds
on the chooser, then signed in through it; NVIDIA refuses an account whose
email is not verified with the generic failure, and the agent held the host
as a create that probably never happened. No CAPTCHA or bot check was
involved: NVIDIA's create form carries only Workday's `noCaptchaWrapper` and
honeypot, and Workday answered the submit. Now the email-method chooser after
a create submit, with no error, counts as created; a refused sign-in right
after this run created the account, or on a pass that retries a
`verify-email` hold, goes to the Gmail verification flow; and a `pending`
account whose saved password is refused gets one mailbox read (tenant origin
only) before the create form is submitted again, where an opened link saves
it as created and holds the host for a later pass. Regression: the
login-redirect, login-redirect-pending and login-redirect-late scenarios in
`testing-harness/browser/workday-account-run.ts` (`xvfb-run -a pnpm
test:browser:workday-account`), against the fixture's synthetic
`?account=login-redirect` mode (the chooser first, a create that sends the
page to `/login`, the generic failure for an unverified account). Not
verified live: that the NVIDIA account exists and its verification email
arrived (the mailbox was not read), and whether NVIDIA's verification link
is on the tenant's host, which the pending recovery needs; the live proof is
a retry of the three jobs.
