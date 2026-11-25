# Workday's create-account submit was held after 20 seconds

On 2026-11-20 three automatic runs checked the terms box on Workday's
create-account form, submitted it, and then held the host with "the account
step stopped (Workday did not answer within 20 seconds)": Example
Brands (examplebrands.wd5.myworkdayjobs.com, 08:31Z), Example
Insurance (employer-f.wd1, 10:23Z), and Example Nonprofit (employer-e.wd5,
14:23Z). The password is saved before the submit, so each account may or may
not exist. Cause: `settle` in `packages/browser/src/ats/workday-account.ts`
gave every submit a fixed 20 seconds and turned anything else into a generic
"other" result. Now a create-account submit gets up to 60 seconds (checked
every 500 ms; a sign-in still 20); "already exists", and no answer within
60 seconds, lead to one sign-in with the saved password (signed in goes on,
a verification screen goes to the Gmail flow, a refused sign-in holds as
`exists` or `interrupted`); an error banner holds with Workday's redacted
text; a CAPTCHA holds and is never solved; every hold reason names what
happened (`workday-account-service.ts`).

If both the create-account submit and its one follow-up sign-in time out,
the agent checks the configured mailbox once for a verification message
associated with the pending account. It opens only a unique verification link
whose HTTPS origin exactly matches the career site. Missing, ambiguous,
unreadable, or off-origin mail leaves the account pending with its original
`unexpected` hold. If opening the verification page fails, the hold uses a
generic reason that omits the activation URL and token. A valid link uses the
existing verification and sign-in flow.

These holds are entries in the
accounts file, not saved runs (the account step runs before the walk), so
`pnpm pipeline:retry --held` now releases holds of kind `unexpected`, and
the next pass signs in with the saved password. Regressions: the slow
create, slow verify, double create, silent, lost, and banner scenarios and
the six dual-timeout mailbox cases (valid, missing, ambiguous, unreadable,
off-origin, and navigation failure) in
`testing-harness/browser/workday-account-run.ts` (`pnpm
test:browser:workday-account`), the no-answer and existing-account cases in
`run-lifecycle.integration.test.ts`, and the account-hold cases in
`automatic-retry.integration.test.ts`.
